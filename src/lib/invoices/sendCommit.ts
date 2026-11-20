// One wrapper around the DB function. The function is the only
// place in this train that writes `invoice_submissions`
// (prompt §5 + migration record).
//
// Signature per the record file:
//   invoices_v2_commit_send(p_draft_id uuid, p_owner_email text, p_mode text)
//     returns table (result text, invoice_id uuid)
//
// Result strings, exactly: 'sent' | 'already_sent' | 'copy' |
// 'not_ready' | 'not_a_draft' | 'not_found'. The function stores
// a credit total as negative itself.

import type { SupabaseClient } from "@supabase/supabase-js";

export type CommitResult =
  | { result: "sent"; invoice_id: string }
  | { result: "already_sent"; invoice_id: string }
  | { result: "copy"; invoice_id: null }
  | { result: "not_ready"; invoice_id: null }
  | { result: "not_a_draft"; invoice_id: null }
  | { result: "not_found"; invoice_id: null };

export async function commitSend(
  sb: SupabaseClient,
  draftId: string,
  ownerEmail: string,
  mode: "test" | "live",
): Promise<CommitResult> {
  const { data, error } = await sb.rpc("invoices_v2_commit_send", {
    p_draft_id: draftId,
    p_owner_email: ownerEmail,
    p_mode: mode,
  });
  if (error) {
    // The function raises on an unknown mode; nothing else should
    // throw. Fail closed as not_found so the caller returns a 409
    // rather than a 500.
    return { result: "not_found", invoice_id: null };
  }
  // RETURNS TABLE: supabase-js returns an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.result !== "string") {
    return { result: "not_found", invoice_id: null };
  }
  const r = row.result as CommitResult["result"];
  if (r === "sent" || r === "already_sent") {
    const id = typeof row.invoice_id === "string" ? row.invoice_id : null;
    if (id == null) return { result: "not_found", invoice_id: null };
    return { result: r, invoice_id: id };
  }
  return { result: r, invoice_id: null };
}
