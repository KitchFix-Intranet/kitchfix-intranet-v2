// "Latest sent" strip for the landing. Five newest counting rows for
// the site. Server.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface LatestSentRow {
  id: string;
  vendor_name: string;
  invoice_number: string;
  submitted_at: string;
  total_amount: number;
  type: "invoice" | "credit";
}

export async function loadLatestSent(
  sb: SupabaseClient,
  accountKey: string,
  limit: number = 5,
): Promise<LatestSentRow[]> {
  const q = await sb
    .from("invoice_submissions")
    .select("id, vendor_name, invoice_number, submitted_at, total_amount, type")
    .eq("account_key", accountKey)
    .not("status", "in", "(deleted,corrected,archived)")
    .order("submitted_at", { ascending: false })
    .limit(limit);
  if (q.error) return [];
  const rows = (q.data ?? []) as Array<{
    id: string; vendor_name: string | null; invoice_number: string | null;
    submitted_at: string; total_amount: number | string | null; type: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    vendor_name: r.vendor_name ?? "",
    invoice_number: r.invoice_number ?? "",
    submitted_at: r.submitted_at,
    total_amount: typeof r.total_amount === "number" ? r.total_amount : Number(r.total_amount ?? 0),
    type: r.type === "credit" ? "credit" : "invoice",
  }));
}

// Returned-for-this-site rows for the landing's B2 needs-fix note:
// vendor + invoice number, oldest-returned first (so the note
// surfaces the one that has been waiting longest).
export interface ReturnedRow {
  id: string;
  vendor_name: string;
  invoice_number: string;
}

export async function loadReturnedForSite(
  sb: SupabaseClient,
  accountKey: string,
  limit: number = 4,
): Promise<ReturnedRow[]> {
  const q = await sb
    .from("invoice_submissions")
    .select("id, vendor_name, invoice_number, submitted_at")
    .eq("account_key", accountKey)
    .eq("status", "returned")
    .order("submitted_at", { ascending: true })
    .limit(limit);
  if (q.error) return [];
  const rows = (q.data ?? []) as Array<{ id: string; vendor_name: string | null; invoice_number: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    vendor_name: r.vendor_name ?? "",
    invoice_number: r.invoice_number ?? "",
  }));
}
