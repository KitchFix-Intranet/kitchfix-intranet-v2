// Train 3 §7 "You are set": invoices this person sent at this
// site in the last 12 hours. Used only when drafts are empty and
// the switch is test/live - the "N ready" form stays for switch
// off.
//
// Joins `invoice_sends` for mode + email_status so the row can
// show "With accounting" / "Test send" / "Sending" directly.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface RecentlySentRow {
  invoice_id: string;
  vendor_name: string;
  invoice_number: string;
  kind: "invoice" | "credit";
  v2_mode: "test" | "live";
  v2_email_status: "held" | "sent" | "gave_up";
}

export async function loadRecentlySent(
  sb: SupabaseClient,
  ownerEmail: string,
  accountKey: string,
  hoursBack: number = 12,
): Promise<RecentlySentRow[]> {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  // 1. Submissions by this owner at this site, submitted inside
  //    the window. Scoped by owner (submitter_email = lower).
  const subs = await sb
    .from("invoice_submissions")
    .select("id, vendor_name, invoice_number, type")
    .eq("account_key", accountKey)
    .eq("submitter_email", ownerEmail)
    .gte("submitted_at", cutoff)
    .not("status", "in", "(deleted,corrected,archived)")
    .order("submitted_at", { ascending: false })
    .limit(25);
  if (subs.error || !subs.data) return [];
  const rows = subs.data as Array<{ id: string; vendor_name: string | null; invoice_number: string | null; type: string | null }>;
  if (rows.length === 0) return [];

  // 2. Join invoice_sends to find the V2 ones (v1 invoices have
  //    no row and are excluded).
  const ids = rows.map((r) => r.id);
  const sends = await sb
    .from("invoice_sends")
    .select("submission_id, mode, email_status")
    .in("submission_id", ids);
  if (sends.error) return [];
  const byId = new Map<string, { mode: "test" | "live"; email_status: "held" | "sent" | "gave_up" }>();
  for (const s of (sends.data ?? []) as Array<{ submission_id: string; mode: string; email_status: string }>) {
    if ((s.mode === "test" || s.mode === "live") && (s.email_status === "held" || s.email_status === "sent" || s.email_status === "gave_up")) {
      byId.set(s.submission_id, { mode: s.mode, email_status: s.email_status });
    }
  }

  const out: RecentlySentRow[] = [];
  for (const r of rows) {
    const send = byId.get(r.id);
    if (!send) continue;
    out.push({
      invoice_id: r.id,
      vendor_name: r.vendor_name ?? "",
      invoice_number: r.invoice_number ?? "",
      kind: r.type === "credit" ? "credit" : "invoice",
      v2_mode: send.mode,
      v2_email_status: send.email_status,
    });
  }
  return out;
}
