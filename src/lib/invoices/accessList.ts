// The in-scope account list the loader reads at the top of every
// page. Rule (per Kevin 2026-11-17): accounts where active = true
// AND team_key != 'CORP'. 11 today - 9 that carry invoices, 2 that
// do not. The site select lists all 11; a site with no invoices
// shows "Nothing sent yet" on selection. This rule does NOT
// intersect with "has invoices".

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteAccount } from "./scope";

export async function loadInvoiceSites(sb: SupabaseClient): Promise<SiteAccount[]> {
  const q = await sb
    .from("accounts")
    .select("team_key, name, region")
    .eq("active", true)
    .neq("team_key", "CORP")
    .order("team_key");
  if (q.error) throw new Error(`accounts: ${q.error.message}`);
  return (q.data ?? []) as SiteAccount[];
}
