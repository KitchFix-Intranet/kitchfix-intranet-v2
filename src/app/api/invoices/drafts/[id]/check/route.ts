// /api/invoices/drafts/[id]/check
//   POST - run the Ready check. No DB write (train 2 never sets
//   status='sent'); the client uses the returned shape to label the
//   draft Ready in memory, show the C9 stop block when a copy is
//   found, and flip the cursor to the next not-ready draft.
//
// Train 2b correction 4 / correction 6:
//   - copy_match: the client-safe snapshot of the matched row
//     (vendor_name, invoice_number, invoice_date, submission_id).
//     C9's stop block reads it directly - no extra client fetch.
//   - next_draft_id: the oldest (created_at ASC) not-ready draft
//     for this (owner, site) excluding the one just checked. null
//     when none remain - the sitting routes to the landing, which
//     shows E (every draft is ready).

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, listFilesForDraft, listDraftsForOwnerSiteFixedOrder } from "@/lib/invoices/draftLoad";
import { runReadyCheck } from "@/lib/invoices/readyCheck";
import { activeCodesSetForSite } from "@/lib/invoices/glCodes";
import { vendorIsAvailable } from "@/lib/invoices/vendorPicker";
import { copyCheck } from "@/lib/invoices/duplicateCheck";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  // The check route is read-only in terms of DB writes, but it only
  // makes sense for the owner of the draft; run with write:false so
  // owner preview can still exercise it.
  const open = await openInvoiceApi({ as, write: false });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });

  const [files, codeSet, vendorOk, copyResult] = await Promise.all([
    listFilesForDraft(sb, ownerEmail, draftId),
    activeCodesSetForSite(sb, draft.account_key),
    draft.vendor_id ? vendorIsAvailable(sb, draft.vendor_id) : Promise.resolve(false),
    copyCheck(sb, ownerEmail, draft),
  ]);

  const result = runReadyCheck({
    draft,
    files,
    activeCodesForSite: codeSet,
    vendorInScope: vendorOk,
    copyError: copyResult ? copyResult.kind : null,
  });

  // Next-draft cursor. Server-computed so the sitting does not need
  // a second round-trip after a ready pass. Walks this (owner, site)
  // in fixed order, returning the first draft that is not ready.
  // Only computed when the current draft is now ready - a failing
  // check keeps the cursor on the current draft.
  let nextDraftId: string | null = null;
  if (result.ready) {
    const all = await listDraftsForOwnerSiteFixedOrder(sb, ownerEmail, draft.account_key);
    for (const d of all) {
      if (d.id === draft.id) continue;
      const [dfiles, dvendorOk, dcopy] = await Promise.all([
        listFilesForDraft(sb, ownerEmail, d.id),
        d.vendor_id ? vendorIsAvailable(sb, d.vendor_id) : Promise.resolve(false),
        copyCheck(sb, ownerEmail, d),
      ]);
      const dres = runReadyCheck({
        draft: d,
        files: dfiles,
        activeCodesForSite: codeSet,
        vendorInScope: dvendorOk,
        copyError: dcopy ? dcopy.kind : null,
      });
      if (!dres.ready) { nextDraftId = d.id; break; }
    }
  }

  return NextResponse.json({
    ready: result.ready,
    errors: result.errors,
    copy_match: copyResult?.match ?? null,
    next_draft_id: nextDraftId,
  });
}
