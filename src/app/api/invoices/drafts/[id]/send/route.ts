// POST /api/invoices/drafts/[id]/send
//
// §5 of train 3:
//   1. Switch off -> 409 sending_off.
//   2. Re-run the same Ready check the check route runs.
//      Not ready -> 409 with errors.
//   3. Call invoices_v2_commit_send. The DB function is the
//      only writer of `invoice_submissions` in this train.
//   4. Deliver once in the same request (correction 2: claim
//      the send row before delivering; release the claim at
//      the end, pass or fail).
//   5. Answer the browser with what is true: delivered or held.
//
// Correction 2 also:
//   - already_sent + email_status='sent' -> answer delivered,
//     send nothing;
//   - already_sent + held + cannot claim -> answer held (the
//     retry job owns it right now).
//
// Correction 5: on a DB 'copy' result, say "This vendor,
// number, date and total are already on file." with two ways
// out. No second read, no other site's details.
//
// Correction 9: maxDuration = 60.
//
// Pre-push fix 7: if the draft's status is already 'sent' we
// skip the Ready re-run. The copy check would otherwise find
// the draft's own submitted invoice and answer not_ready.
// Commit is still called - the DB function returns already_sent
// and we go on to deliver (or no-op if already delivered).
//
// Pre-push fix 4 ride-along: deliverSend may ask us to KEEP the
// claim (sent-mark failed 3x) by returning keepClaim=true.
// Skip releaseClaim in that case; an operator clears the row
// by hand.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import {
  getDraftById, listFilesForDraft, listDraftsForOwnerSiteFixedOrder,
} from "@/lib/invoices/draftLoad";
import { runReadyCheck } from "@/lib/invoices/readyCheck";
import { activeCodesSetForSite } from "@/lib/invoices/glCodes";
import { vendorIsAvailable } from "@/lib/invoices/vendorPicker";
import { copyCheck } from "@/lib/invoices/duplicateCheck";
import { outboundMode } from "@/lib/invoices/outboundGate";
import { commitSend } from "@/lib/invoices/sendCommit";
import { tryClaim, releaseClaim } from "@/lib/invoices/claim";
import { deliverSend } from "@/lib/invoices/deliverSend";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftRow, ReadyResult } from "@/lib/invoices/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const url = new URL(req.url);
  const as = url.searchParams.get("as");

  const mode = outboundMode();

  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) {
    return new Response(null, { status: 404 });
  }

  // Fix 7: a draft that is already 'sent' carries submission_id;
  // the Ready check's copy check would match the draft's own
  // submitted invoice and refuse. Skip Ready, go straight to
  // commit (which returns already_sent) and on to deliver.
  const skipReady = draft.status === "sent";

  // Re-run Ready with the same inputs the check route uses
  // (unless skipping - fix 7).
  let check: ReadyResult;
  let codeSet: ReadonlySet<string>;
  let copyResult: Awaited<ReturnType<typeof copyCheck>> = null;
  if (skipReady) {
    codeSet = await activeCodesSetForSite(sb, draft.account_key);
    check = { ready: true, errors: [] };
  } else {
    const [files, codeSetLocal, vendorOk, copyLocal] = await Promise.all([
      listFilesForDraft(sb, ownerEmail, draftId),
      activeCodesSetForSite(sb, draft.account_key),
      draft.vendor_id ? vendorIsAvailable(sb, draft.vendor_id) : Promise.resolve(false),
      copyCheck(sb, ownerEmail, draft),
    ]);
    void files; // runReadyCheck takes it next
    codeSet = codeSetLocal;
    copyResult = copyLocal;
    check = runReadyCheck({
      draft, files, activeCodesForSite: codeSet, vendorInScope: vendorOk,
      copyError: copyResult ? copyResult.kind : null,
    });
  }

  // 1. Switch off: refuse with 409 sending_off per prompt §5.
  //    The body still carries today's check-route shape so the
  //    browser can show today's "Ready..." toast or error list
  //    without a second round-trip.
  if (mode === "off") {
    const nextDraftId = check.ready ? await findNextUnreadyDraftId(sb, ownerEmail, draft.account_key, draft.id, codeSet) : null;
    return NextResponse.json({
      kind: "sending_off",
      ready: check.ready,
      errors: check.errors,
      copy_match: copyResult?.match ?? null,
      next_draft_id: nextDraftId,
    }, { status: 409 });
  }

  if (!check.ready) {
    return NextResponse.json({
      kind: "not_ready",
      errors: check.errors,
      copy_match: copyResult?.match ?? null,
    }, { status: 409 });
  }

  // 3. Commit. The DB function is the one writer of invoice_submissions.
  const commit = await commitSend(sb, draftId, ownerEmail, mode);
  if (commit.result === "not_ready" || commit.result === "not_a_draft" || commit.result === "not_found") {
    return NextResponse.json({ kind: commit.result }, { status: 409 });
  }
  if (commit.result === "copy") {
    // Correction 5: no second read; no other site's details.
    return NextResponse.json({
      kind: "copy",
      message: "This vendor, number, date and total are already on file.",
    }, { status: 409 });
  }
  const invoiceId = commit.invoice_id;

  // Pull the send row. "sent" came with a fresh row; "already_sent"
  // may be either sent-and-done or still-held.
  const { data: sendRow } = await sb
    .from("invoice_sends")
    .select("id, mode, email_status")
    .eq("submission_id", invoiceId)
    .maybeSingle();
  if (!sendRow) {
    return NextResponse.json({
      kind: "held", invoice_id: invoiceId, code: "no_send_row",
    }, { status: 200 });
  }
  const rowMode = sendRow.mode as "test" | "live";

  const nextDraftId = await findNextUnreadyDraftId(sb, ownerEmail, draft.account_key, draft.id, codeSet);

  if (sendRow.email_status === "sent") {
    // already_sent + delivered: do not send a second email.
    return NextResponse.json({
      kind: "delivered", invoice_id: invoiceId, mode: rowMode, next_draft_id: nextDraftId,
    }, { status: 200 });
  }

  // 4. Claim before deliver. Another process may race (the cron
  //    job, or a parallel tab); the one that wins the conditional
  //    UPDATE delivers.
  const claimed = await tryClaim(sb, sendRow.id);
  if (!claimed) {
    return NextResponse.json({
      kind: "held", invoice_id: invoiceId, mode: rowMode, next_draft_id: nextDraftId,
    }, { status: 200 });
  }

  // 5. Deliver + release. The deliver function records its own
  //    attempt rows and transitions invoice_sends.
  //    Fix 4: if deliverSend asks us to keep the claim (sent-
  //    mark UPDATE failed 3x), do not release it here.
  let keepClaim = false;
  try {
    const result = await deliverSend({
      sb, sendId: sendRow.id, invoiceId, rowMode, switchMode: mode,
    });
    keepClaim = Boolean(result.keepClaim);
    return NextResponse.json({
      kind: result.kind,
      invoice_id: invoiceId,
      mode: rowMode,
      next_draft_id: nextDraftId,
      ...(result.code ? { code: result.code } : {}),
    }, { status: 200 });
  } finally {
    if (!keepClaim) await releaseClaim(sb, sendRow.id);
  }
}

// Mirror of /check's next-draft cursor: oldest (created_at ASC)
// not-ready draft for this (owner, site), excluding the one just
// handled. The sitting routes here on ready/delivered/held so
// the move-on is server-decided.
async function findNextUnreadyDraftId(
  sb: SupabaseClient,
  ownerEmail: string,
  accountKey: string,
  skipDraftId: string,
  codeSet: ReadonlySet<string>,
): Promise<string | null> {
  const all = await listDraftsForOwnerSiteFixedOrder(sb, ownerEmail, accountKey);
  for (const d of all) {
    if (d.id === skipDraftId) continue;
    const [dfiles, dvendorOk, dcopy] = await Promise.all([
      listFilesForDraft(sb, ownerEmail, d.id),
      d.vendor_id ? vendorIsAvailable(sb, d.vendor_id) : Promise.resolve(false),
      copyCheck(sb, ownerEmail, d),
    ]);
    const dres = runReadyCheck({
      draft: d as DraftRow,
      files: dfiles,
      activeCodesForSite: codeSet,
      vendorInScope: dvendorOk,
      copyError: dcopy ? dcopy.kind : null,
    });
    if (!dres.ready) return d.id;
  }
  return null;
}
