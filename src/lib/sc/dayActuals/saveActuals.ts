// Port of v1's saveActualsPostgres into V2.
//
// Touched-only upsert against the unique key (account_key, service_id,
// service_date). An untouched service is not in the entries array and
// is preserved on disk (rule 13). A typed 0 is a row with actual_count=0.
//
// The BEFORE UPDATE trigger on sc_daily_actuals writes history on any
// count change; this function writes nothing to the history table.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SaveEntry } from "./types";

export async function saveActuals(
  sb: SupabaseClient,
  accountKey: string,
  serviceDate: string,
  entries: SaveEntry[],
  email: string,
): Promise<{ written: number }> {
  if (!entries.length) return { written: 0 };
  const now = new Date().toISOString();
  const rows = entries.map((e) => ({
    account_key:  accountKey,
    service_id:   e.serviceId,
    service_date: serviceDate,
    actual_count: e.actualCount,
    created_by:   email,
    updated_by:   email,
    updated_at:   now,
  }));
  const { error } = await sb
    .from("sc_daily_actuals")
    .upsert(rows, { onConflict: "account_key,service_id,service_date", ignoreDuplicates: false });
  if (error) throw new Error(`saveActuals: ${error.message}`);
  return { written: rows.length };
}

// Clear-to-projections. DELETE the day's actuals rows. The BEFORE
// DELETE trigger on sc_daily_actuals writes one history row per row
// deleted with change_type='delete'. The caller has already run both
// locks and the concurrency token check.
export async function deleteDayActuals(
  sb: SupabaseClient,
  accountKey: string,
  serviceDate: string,
): Promise<{ deleted: number }> {
  const { data, error } = await sb
    .from("sc_daily_actuals")
    .delete()
    .eq("account_key", accountKey)
    .eq("service_date", serviceDate)
    .select("service_id");
  if (error) throw new Error(`deleteDayActuals: ${error.message}`);
  return { deleted: data?.length ?? 0 };
}
