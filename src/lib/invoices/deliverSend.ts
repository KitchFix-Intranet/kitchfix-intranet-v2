// Invoices V2 - the one deliver function used by the send route
// and the retry route.
//
// C2 STUB. This commit lands the shell so the send route
// compiles and the full claim + release flow is exercisable
// without a real mail call. C4 replaces the body with: the
// outbound PDF build, sendSystemMail, the per-row mayDeliver
// check, the Slack post, invoice_send_attempts row, and the
// invoice_sends state transitions (sent / held / gave_up).
//
// The current body records a failed attempt with error_code
// 'not_wired', holds the row with a 10-minute next_attempt_at,
// and returns kind='held'. Nothing leaves the process.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OutboundMode } from "./outboundGate";
import type { RowMode } from "./recipients";

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

export async function deliverSend(args: DeliverArgs): Promise<DeliverResult> {
  const { sb, sendId } = args;
  const code = "not_wired";
  const nowIso = new Date().toISOString();
  const nextIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await sb.from("invoice_send_attempts").insert({
    send_id: sendId,
    channel: "email",
    result: "failed",
    error_code: code,
  });
  await sb
    .from("invoice_sends")
    .update({
      email_status: "held",
      email_attempts: 1,
      email_last_error: code,
      email_next_attempt_at: nextIso,
      updated_at: nowIso,
    })
    .eq("id", sendId);
  return { kind: "held", code };
}
