// Invoices V2 - the one deliver function used by the send route
// and the retry route (prompt §6).
//
// Does one thing: takes an invoice_sends row (held or pending)
// and tries to deliver it. Never throws. Writes:
//   - invoice_files one row (kind='outbound') on the FIRST
//     successful or failed attempt that gets as far as "need
//     the PDF". Later retries reuse the stored file.
//   - invoice_send_attempts one row per attempt.
//   - invoice_sends: transitions email_status to sent / held /
//     gave_up + updates email_attempts, email_last_error,
//     email_next_attempt_at, email_sent_at, email_message_id,
//     outbound_file_id, slack_status.
//   - invoice_submissions.email_sent = true on delivery. That
//     one column on that one row is the only update this train
//     makes to invoice_submissions (prompt §6).
//
// Server-only: pulls in node:crypto (sha256) via fileSha and
// pdf-lib via buildOutboundPdf.
//
// Slack (prompt §6 + correction 9):
//   - First attempt: always post the outcome (delivered or
//     held:<code>). invoice_sends.slack_status moves from
//     'pending' to sent/failed/skipped and an attempts row
//     logs the post.
//   - Later attempts: post a SECOND time only when the row
//     transitions to 'sent' or 'gave_up'. Not on a repeat
//     'held'.
//
// Pre-push fixes applied here:
//   fix 1: a download failure in buildOutboundPdf now throws
//     OriginalReadFailed; we catch it and hold with the code
//     `original_read_failed` so the retry tries again. An
//     invoice is never emailed unless every live original is in
//     the email.
//   fix 2: buildOutboundPdf returns { bytes, extras }. The
//     extras ride as REAL email attachments (never as PDF-
//     embedded attach() payloads). When nothing would ship we
//     hold with `no_pages`.
//   fix 4: after the mail provider acks, the invoice_sends
//     "mark sent" UPDATE is retried up to 3 times. If all 3
//     fail, DO NOT release the claim - extend claimed_until by
//     24 hours and post a Slack "sent, but could not be marked
//     sent". The result carries keepClaim=true so the routes
//     skip their finally releaseClaim. The row is cleared once
//     an operator manually sets email_status='sent' and
//     claimed_until=null (or the 24h hold lapses and a human
//     intervenes).
//   mayDeliver: the defence-in-depth path writes nothing now -
//     it just returns held. The route-level and retry-level
//     gates are the real control.

if (typeof window !== "undefined") {
  throw new Error("src/lib/invoices/deliverSend.ts is server-only");
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { sendSystemMail, MAX_MESSAGE_BYTES } from "@/lib/mail";
import { mayDeliver } from "./mayDeliver";
import { resolveRecipients, type RowMode } from "./recipients";
import type { OutboundMode } from "./outboundGate";
import { buildCodingPageData } from "./codingPageData";
import {
  buildOutboundPdf,
  OriginalReadFailed,
  type OutboundFileRef,
  type ExtraAttachment,
} from "./buildOutboundPdf";
import { outboundFileName } from "./outboundFileName";
import { buildSubject } from "./emailSubject";
import { buildEmailBody } from "./emailBody";
import { parseSubmitterName } from "./submitterName";
import { postSlack, type SlackResult } from "./slackPost";
import { decideRetry } from "./retrySchedule";
import { insertOutboundFile } from "./draftWrite";
import { sha256Hex } from "./fileSha";

export interface DeliverArgs {
  sb: SupabaseClient;
  sendId: string;
  invoiceId: string;
  rowMode: RowMode;
  switchMode: OutboundMode;
}

export interface DeliverResult {
  kind: "delivered" | "held" | "gave_up";
  code?: string;
  // Fix 4: when the sent-mark UPDATE failed 3 times, the caller
  // MUST NOT release the claim. The row stays locked for 24h.
  keepClaim?: boolean;
}

const BUCKET = "invoice-files";
const SIGNED_URL_SECS = 60;
const MARK_SENT_RETRIES = 3;
const KEEP_CLAIM_EXTEND_MS = 24 * 60 * 60 * 1000;

export async function deliverSend(args: DeliverArgs): Promise<DeliverResult> {
  const { sb, sendId, invoiceId, rowMode, switchMode } = args;

  // Defence in depth. mayDeliver should always be true by this
  // point (the send route gates on switch !== off, the retry
  // route gates the same way, and the row's mode was set at
  // commit). Return held and write NOTHING - the real gates
  // live at the route layer.
  if (!mayDeliver(rowMode, switchMode)) {
    return { kind: "held", code: "may_not_deliver" };
  }

  // Load the current send row + the invoice.
  const { data: send, error: sendErr } = await sb
    .from("invoice_sends")
    .select("id, submission_id, mode, email_status, email_attempts, email_next_attempt_at, email_sent_at, email_message_id, outbound_file_id, slack_status, created_at")
    .eq("id", sendId)
    .maybeSingle();
  if (sendErr || !send) {
    return { kind: "held", code: "send_missing" };
  }

  const { data: inv, error: invErr } = await sb
    .from("invoice_submissions")
    .select("id, account_key, vendor_name, vendor_id, invoice_number, invoice_date, total_amount, type, gl_breakdown, submitter_email, submitted_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr || !inv) {
    return await recordHeld(sb, sendId, invoiceId, "invoice_missing", send.slack_status === "pending", null);
  }

  // Build the coding page data. The submitter's first name +
  // last initial comes from `people` keyed by work_email; a
  // missing people row means the byline is left off
  // (correction 6).
  const subEmailLower = (inv.submitter_email ?? "").trim().toLowerCase();
  const { data: peopleRow } = subEmailLower
    ? await sb.from("people").select("display_name").eq("work_email", subEmailLower).maybeSingle()
    : { data: null } as { data: { display_name: string | null } | null };
  const nameParts = parseSubmitterName(peopleRow?.display_name ?? null);

  const coding = buildCodingPageData(
    {
      account_key: inv.account_key,
      vendor_name: inv.vendor_name,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      total_amount: typeof inv.total_amount === "number" ? inv.total_amount : Number(inv.total_amount),
      type: inv.type as "invoice" | "credit",
      gl_breakdown: Array.isArray(inv.gl_breakdown) ? inv.gl_breakdown : [],
      submitted_at: inv.submitted_at,
    },
    nameParts,
    rowMode,
  );

  // Recipients from the ROW's mode - correction 3.
  const rec = resolveRecipients(rowMode, {
    INVOICE_AP_TO_EMAIL: process.env.INVOICE_AP_TO_EMAIL,
    INVOICES_V2_TEST_TO: process.env.INVOICES_V2_TEST_TO,
    INVOICES_V2_CC: process.env.INVOICES_V2_CC,
  }, inv.submitter_email ?? null);

  if (!rec.ok) {
    // Missing env: hold with that code; Slack says why. First-
    // post rules apply.
    const slackText = buildSlackText({
      mode: rowMode, kind: inv.type as "invoice" | "credit",
      site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
      who: nameParts.first_name, outcome: `held: ${rec.code}`,
    });
    return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, rec.code, send.slack_status === "pending", slackText);
  }

  // Build the outbound PDF. The retry path rebuilds the SAME
  // attachments from the SAME originals - previously the retry
  // branch read only the stored PDF and dropped extras, so a
  // retry for an invoice whose originals were a locked PDF or a
  // WebP would ship a coding page with no invoice. Always collect
  // originals + run buildOutboundPdf; only the store-and-insert
  // step is skipped when outbound_file_id is already set. A read
  // failure of any original on first try or retry holds with
  // code original_read_failed.
  let outboundFileId: string | null = send.outbound_file_id ?? null;
  let outboundFileNameValue = outboundFileName(inv.vendor_name, inv.invoice_date, inv.invoice_number, rowMode);

  const { data: origFiles } = await sb
    .from("invoice_files")
    .select("id, storage_path, mime_type, rotation, sort_order, file_name")
    .eq("submission_id", invoiceId)
    .eq("kind", "original")
    .is("removed_at", null)
    .order("sort_order", { ascending: true });
  const refs: OutboundFileRef[] = (origFiles ?? []).map((f: { storage_path: string; mime_type: string; rotation: number; file_name: string | null }) => ({
    storage_path: f.storage_path,
    mime_type: f.mime_type,
    rotation: (f.rotation ?? 0) as 0 | 90 | 180 | 270,
    file_name: f.file_name ?? null,
  }));

  // Fix 2: zero originals would mean emailing an invoice-less
  // message. Refuse.
  if (refs.length === 0) {
    return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "no_pages", send.slack_status === "pending", buildSlackText({
      mode: rowMode, kind: inv.type as "invoice" | "credit",
      site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
      who: nameParts.first_name, outcome: "held: no_pages",
    }));
  }

  let outboundBytes: Uint8Array;
  let extras: ExtraAttachment[] = [];
  try {
    const built = await buildOutboundPdf(sb, refs, coding);
    outboundBytes = built.bytes;
    extras = built.extras;
  } catch (e) {
    // Fix 1: an original that failed to download does not get
    // silently skipped; the whole build fails so the retry can
    // try again later. Same rule on retries.
    const code = e instanceof OriginalReadFailed ? "original_read_failed" : "pdf_build_failed";
    return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, code, send.slack_status === "pending", buildSlackText({
      mode: rowMode, kind: inv.type as "invoice" | "credit",
      site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
      who: nameParts.first_name, outcome: `held: ${code}`,
    }));
  }

  if (outboundFileId == null) {
    // First try: store + insert so the drawer's view link works
    // and the row ties the send to a persisted file.
    const fileId = randomUUID();
    const storagePath = `outbound/${invoiceId}/${fileId}.pdf`;
    const up = await sb.storage.from(BUCKET).upload(storagePath, outboundBytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (up.error) {
      return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "storage_upload_failed", send.slack_status === "pending", buildSlackText({
        mode: rowMode, kind: inv.type as "invoice" | "credit",
        site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
        who: nameParts.first_name, outcome: "held: storage_upload_failed",
      }));
    }
    const ins = await insertOutboundFile(sb, {
      id: fileId,
      submissionId: invoiceId,
      storagePath,
      fileName: outboundFileNameValue,
      sizeBytes: outboundBytes.byteLength,
      sha256: sha256Hex(outboundBytes),
      pageCount: null,
      uploadedBy: subEmailLower || "system",
    });
    if (!ins.row) {
      await sb.storage.from(BUCKET).remove([storagePath]);
      return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "outbound_insert_failed", send.slack_status === "pending", buildSlackText({
        mode: rowMode, kind: inv.type as "invoice" | "credit",
        site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
        who: nameParts.first_name, outcome: "held: outbound_insert_failed",
      }));
    }
    outboundFileId = ins.row.id;
    await sb.from("invoice_sends").update({ outbound_file_id: outboundFileId, updated_at: new Date().toISOString() }).eq("id", sendId);
  } else {
    // Retry: preserve the first try's filename so the email
    // header matches. Bytes come from the rebuild above.
    const { data: fileRow } = await sb
      .from("invoice_files")
      .select("file_name")
      .eq("id", outboundFileId)
      .maybeSingle();
    if (fileRow?.file_name) outboundFileNameValue = fileRow.file_name;
  }

  // Compose the message.
  const subject = buildSubject({
    mode: rowMode, kind: inv.type as "invoice" | "credit",
    site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
    total: typeof inv.total_amount === "number" ? inv.total_amount : Number(inv.total_amount),
  });
  const html = buildEmailBody(coding);
  const senderAddr = (process.env.INVOICE_SA_SENDER ?? "").trim();
  if (!senderAddr) {
    return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "missing_env:INVOICE_SA_SENDER", send.slack_status === "pending", buildSlackText({
      mode: rowMode, kind: inv.type as "invoice" | "credit",
      site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
      who: nameParts.first_name, outcome: "held: missing_env:INVOICE_SA_SENDER",
    }));
  }

  // Fix 2: total payload (main PDF + extras) must fit. Each
  // extra's base64 adds ~4/3 of its raw byte count to the
  // message, plus header overhead; we approximate with the
  // sum of decoded sizes.
  const extrasRawBytes = extras.reduce((acc, a) => acc + Math.floor((a.base64.length * 3) / 4), 0);
  const totalBytes = outboundBytes.byteLength + extrasRawBytes;
  if (totalBytes > MAX_MESSAGE_BYTES) {
    const slackText = `${rowMode === "test" ? "[TEST] " : ""}${inv.account_key} - ${inv.vendor_name} - ${inv.type === "credit" ? "credit" : "invoice"} #${inv.invoice_number}${nameParts.first_name ? ` from ${nameParts.first_name}` : ""} - held: file is too big to email.`;
    return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "too_large", send.slack_status === "pending", slackText);
  }

  const base64 = Buffer.from(outboundBytes).toString("base64");
  const mailResult = await sendSystemMail({
    sender: senderAddr,
    displayName: "KitchFix Invoice Capture",
    to: rec.to,
    cc: rec.cc.length > 0 ? rec.cc : undefined,
    replyTo: (inv.submitter_email ?? "").trim() || undefined,
    subject,
    html,
    attachments: [
      { filename: outboundFileNameValue, mimeType: "application/pdf", base64 },
      ...extras,
    ],
  });

  const slackBase = {
    mode: rowMode,
    kind: inv.type as "invoice" | "credit",
    site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
    who: nameParts.first_name,
  };
  const isFirstSlack = send.slack_status === "pending";

  if (mailResult.ok) {
    // Delivered. The email is OUT; we now mark the row sent.
    // Fix 4: the "mark sent" UPDATE itself may fail (network,
    // transient DB). Retry up to MARK_SENT_RETRIES times. If
    // all retries fail: extend the claim 24h, post Slack
    // "sent, but could not be marked sent", return keepClaim.
    const nowIso = new Date().toISOString();
    const markOk = await markSentWithRetry(sb, sendId, send.email_attempts + 1, mailResult.messageId, nowIso);
    if (!markOk) {
      // Keep the claim so the retry job cannot email a second
      // time. Extend claimed_until +24h and tell someone.
      const extendedUntil = new Date(Date.now() + KEEP_CLAIM_EXTEND_MS).toISOString();
      await sb
        .from("invoice_sends")
        .update({ claimed_until: extendedUntil, updated_at: new Date().toISOString() })
        .eq("id", sendId);
      const alertText = `${rowMode === "test" ? "[TEST] " : ""}${inv.account_key} - ${inv.vendor_name} - ${inv.type === "credit" ? "credit" : "invoice"} #${inv.invoice_number}${nameParts.first_name ? ` from ${nameParts.first_name}` : ""} - sent, but could not be marked sent. The claim is held for 24 hours; set email_status='sent' and claimed_until=null on invoice_sends ${sendId} by hand once it is safe.`;
      await postSlack(alertText, process.env.SLACK_INVOICE_WEBHOOK);
      return { kind: "delivered", keepClaim: true };
    }

    // The sent mark landed. Also mark the submission and log
    // the attempt. These writes are best-effort - if they fail
    // we are no longer at risk of double-sending because the
    // send row already says sent.
    await sb
      .from("invoice_submissions")
      .update({ email_sent: true })
      .eq("id", invoiceId);
    await sb.from("invoice_send_attempts").insert({
      send_id: sendId, channel: "email", result: "sent", error_code: null,
    });

    // Slack: first post OR a second post because a held row now
    // delivered.
    if (isFirstSlack || send.slack_status === "sent" || send.slack_status === "failed" || send.slack_status === "skipped") {
      const text = buildSlackText({ ...slackBase, outcome: "delivered" });
      const slackResult = await postSlack(text, process.env.SLACK_INVOICE_WEBHOOK);
      await recordSlack(sb, sendId, slackResult, isFirstSlack);
    }
    return { kind: "delivered" };
  }

  // Failure. Decide retry vs gave_up, log, post Slack per rules.
  const slackText = buildSlackText({ ...slackBase, outcome: `held: ${mailResult.code}` });
  return await failAndMaybeGiveUp(
    sb, send.id, invoiceId, send.email_attempts, send.created_at,
    mailResult.code, isFirstSlack, slackText,
  );
}

// ─── helpers ──────────────────────────────────────────────────

interface SlackTextInput {
  mode: RowMode;
  kind: "invoice" | "credit";
  site: string;
  vendor: string;
  number: string;
  who: string | null;
  outcome: string;
}

function buildSlackText(i: SlackTextInput): string {
  const testPrefix = i.mode === "test" ? "[TEST] " : "";
  const who = i.who ? ` from ${i.who}` : "";
  const kindWord = i.kind === "credit" ? "credit" : "invoice";
  // No dollar amount - prompt §6.
  return `${testPrefix}${i.site} - ${i.vendor} - ${kindWord} #${i.number}${who} - ${i.outcome}.`;
}

async function recordSlack(
  sb: SupabaseClient,
  sendId: string,
  result: SlackResult,
  isFirst: boolean,
): Promise<void> {
  const nowIso = new Date().toISOString();
  if (isFirst) {
    await sb
      .from("invoice_sends")
      .update({ slack_status: result, updated_at: nowIso })
      .eq("id", sendId);
  }
  await sb.from("invoice_send_attempts").insert({
    send_id: sendId, channel: "slack", result, error_code: null,
  });
}

// Fix 4: the "mark sent" UPDATE is retried up to
// MARK_SENT_RETRIES times. We use .select() so we can tell a
// returned-no-rows failure (did not match our id) apart from a
// network/transport error. Both are retried the same way.
async function markSentWithRetry(
  sb: SupabaseClient,
  sendId: string,
  nextAttempts: number,
  messageId: string,
  nowIso: string,
): Promise<boolean> {
  for (let i = 0; i < MARK_SENT_RETRIES; i += 1) {
    const { data, error } = await sb
      .from("invoice_sends")
      .update({
        email_status: "sent",
        email_attempts: nextAttempts,
        email_last_error: null,
        email_sent_at: nowIso,
        email_message_id: messageId,
        email_next_attempt_at: null,
        updated_at: nowIso,
      })
      .eq("id", sendId)
      .select("id");
    if (!error && Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}

// Writes a held or gave_up row, logs the failed attempt, posts
// Slack per the first/second rule.
async function failAndMaybeGiveUp(
  sb: SupabaseClient,
  sendId: string,
  _invoiceId: string,
  attemptsSoFar: number,
  firstTriedAtIso: string,
  code: string,
  slackIsFirst: boolean,
  slackText: string | null,
): Promise<DeliverResult> {
  const nowIso = new Date().toISOString();
  const now = new Date();
  const firstTriedAt = new Date(firstTriedAtIso);
  const newAttempts = attemptsSoFar + 1;
  const decision = decideRetry(firstTriedAt, newAttempts, now);

  if (decision.kind === "gave_up") {
    await sb
      .from("invoice_sends")
      .update({
        email_status: "gave_up",
        email_attempts: newAttempts,
        email_last_error: code,
        email_next_attempt_at: null,
        updated_at: nowIso,
      })
      .eq("id", sendId);
    await sb.from("invoice_send_attempts").insert({
      send_id: sendId, channel: "email", result: "failed", error_code: code,
    });
    // Second post if the first one already landed; first post
    // otherwise. Either way, we always post gave_up.
    if (slackText) {
      const text = slackText.replace("held:", "gave up:");
      const slackResult = await postSlack(text, process.env.SLACK_INVOICE_WEBHOOK);
      await recordSlack(sb, sendId, slackResult, slackIsFirst);
    }
    return { kind: "gave_up", code };
  }

  // Held: schedule the next attempt.
  await sb
    .from("invoice_sends")
    .update({
      email_status: "held",
      email_attempts: newAttempts,
      email_last_error: code,
      email_next_attempt_at: decision.nextAttemptAt.toISOString(),
      updated_at: nowIso,
    })
    .eq("id", sendId);
  await sb.from("invoice_send_attempts").insert({
    send_id: sendId, channel: "email", result: "failed", error_code: code,
  });

  // Slack: first attempt posts the held line; later attempts
  // do not (correction 9: second post only on later delivered /
  // gave_up).
  if (slackIsFirst && slackText) {
    const slackResult = await postSlack(slackText, process.env.SLACK_INVOICE_WEBHOOK);
    await recordSlack(sb, sendId, slackResult, true);
  }
  return { kind: "held", code };
}

// A direct "mark held and leave the email alone" path for the
// invoice_missing / send_missing short-circuits. Does not
// increment attempts. (The mayDeliver=false case is handled by
// a bare return above - it writes nothing.)
async function recordHeld(
  sb: SupabaseClient,
  sendId: string,
  _invoiceId: string,
  code: string,
  slackIsFirst: boolean,
  slackText: string | null,
): Promise<DeliverResult> {
  const nowIso = new Date().toISOString();
  await sb
    .from("invoice_sends")
    .update({
      email_status: "held",
      email_last_error: code,
      updated_at: nowIso,
    })
    .eq("id", sendId);
  await sb.from("invoice_send_attempts").insert({
    send_id: sendId, channel: "email", result: "failed", error_code: code,
  });
  if (slackIsFirst && slackText) {
    const slackResult = await postSlack(slackText, process.env.SLACK_INVOICE_WEBHOOK);
    await recordSlack(sb, sendId, slackResult, true);
  }
  return { kind: "held", code };
}

// Short-lived link to the stored outbound PDF. Used by the
// drawer in train 1's list (train 3 §7, correction 7 route
// address is /api/invoices/sent/[id]/view - that route owns
// the gating; this helper just mints the URL).
export async function signOutboundViewUrl(
  sb: SupabaseClient,
  outboundFileId: string,
): Promise<string | null> {
  const { data: fileRow } = await sb
    .from("invoice_files")
    .select("storage_path")
    .eq("id", outboundFileId)
    .maybeSingle();
  if (!fileRow) return null;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(fileRow.storage_path, SIGNED_URL_SECS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
