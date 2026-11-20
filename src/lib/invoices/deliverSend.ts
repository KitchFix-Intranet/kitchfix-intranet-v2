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
import { buildOutboundPdf, type OutboundFileRef } from "./buildOutboundPdf";
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
}

const BUCKET = "invoice-files";
const SIGNED_URL_SECS = 60;

export async function deliverSend(args: DeliverArgs): Promise<DeliverResult> {
  const { sb, sendId, invoiceId, rowMode, switchMode } = args;

  // Defence in depth: mayDeliver should always be true by this
  // point (the send route gates on switch !== off, the retry
  // route gates the same way, and the row's mode was set at
  // commit). Hold rather than send if the matrix says no.
  if (!mayDeliver(rowMode, switchMode)) {
    return await recordHeld(sb, sendId, invoiceId, "may_not_deliver", /*slackIsFirst*/ false, /*slackText*/ null);
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

  // Build or reuse the outbound PDF.
  let outboundFileId: string | null = send.outbound_file_id ?? null;
  let outboundBytes: Uint8Array | null = null;
  let outboundFileNameValue = outboundFileName(inv.vendor_name, inv.invoice_date, inv.invoice_number, rowMode);

  if (outboundFileId == null) {
    // Need to build it. Collect the live originals.
    const { data: origFiles } = await sb
      .from("invoice_files")
      .select("id, storage_path, mime_type, rotation, sort_order")
      .eq("submission_id", invoiceId)
      .eq("kind", "original")
      .is("removed_at", null)
      .order("sort_order", { ascending: true });
    const refs: OutboundFileRef[] = (origFiles ?? []).map((f: { storage_path: string; mime_type: string; rotation: number }) => ({
      storage_path: f.storage_path,
      mime_type: f.mime_type,
      rotation: (f.rotation ?? 0) as 0 | 90 | 180 | 270,
    }));
    try {
      outboundBytes = await buildOutboundPdf(sb, refs, coding);
    } catch {
      return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "pdf_build_failed", send.slack_status === "pending", buildSlackText({
        mode: rowMode, kind: inv.type as "invoice" | "credit",
        site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
        who: nameParts.first_name, outcome: "held: pdf_build_failed",
      }));
    }

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
      // Clean up the stored object on an insert failure.
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
    // Retry: read the stored bytes via a signed URL. Fail-closed
    // on any read error (will retry via schedule).
    const { data: fileRow } = await sb
      .from("invoice_files")
      .select("storage_path, file_name")
      .eq("id", outboundFileId)
      .maybeSingle();
    if (!fileRow) {
      return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "outbound_file_missing", false, null);
    }
    outboundFileNameValue = fileRow.file_name || outboundFileNameValue;
    const dl = await sb.storage.from(BUCKET).download(fileRow.storage_path);
    if (dl.error || !dl.data) {
      return await failAndMaybeGiveUp(sb, send.id, invoiceId, send.email_attempts, send.created_at, "outbound_file_read_failed", false, null);
    }
    outboundBytes = new Uint8Array(await dl.data.arrayBuffer());
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

  // Early size check so we can post the "too big to email"
  // Slack on the first attempt cleanly.
  if (outboundBytes.byteLength > MAX_MESSAGE_BYTES) {
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
    attachments: [{
      filename: outboundFileNameValue,
      mimeType: "application/pdf",
      base64,
    }],
  });

  const slackBase = {
    mode: rowMode,
    kind: inv.type as "invoice" | "credit",
    site: inv.account_key, vendor: inv.vendor_name, number: inv.invoice_number,
    who: nameParts.first_name,
  };
  const isFirstSlack = send.slack_status === "pending";

  if (mailResult.ok) {
    // Delivered. Transition the row, mark the submission, log
    // the attempt, post Slack (first or second).
    const nowIso = new Date().toISOString();
    await sb
      .from("invoice_sends")
      .update({
        email_status: "sent",
        email_attempts: send.email_attempts + 1,
        email_last_error: null,
        email_sent_at: nowIso,
        email_message_id: mailResult.messageId,
        email_next_attempt_at: null,
        updated_at: nowIso,
      })
      .eq("id", sendId);
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
// mayDeliver defence-in-depth case + the invoice_missing /
// send_missing short-circuits. Does not increment attempts.
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
