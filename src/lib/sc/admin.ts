// Service Calendar lane · Admin seam.
//
// One export: `isScLockOverrideDb(email)`. True when the `people`
// table has any ACTIVE row for that work email with
// `is_sc_lock_override` true. False for no email, no matching row,
// or any failure. It never throws.
//
// The ACTIVE filter was added 2026-11-16 per Kevin ruling. The
// flag counts only when the person is still with the company; a
// terminated row with the flag set cannot unlock a period.
//
// Why "any row": nine work emails sit on more than one `people` row
// today (22 rows: one row per hire, each with its own `worker_id`).
// A single-row read would error on those.
// We ask instead whether any row for the email carries the flag.
//
// Why `.eq` not `.ilike`: `_` is a wildcard in `ilike` and a legal
// character in an email. Exact match on the lower-cased, trimmed
// address is the only safe comparator.
//
// No hardcoded email list. No write to `admin_drift_log`. Train 2
// may extend the rule; this file is the only place to edit when
// that happens.

import { getServiceClient } from "./_seams";
import type { SupabaseClient } from "./types";

export async function isScLockOverrideDb(
  email: string | null | undefined,
  supaArg?: SupabaseClient
): Promise<boolean> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return false;
  try {
    const supa = supaArg || getServiceClient();
    const { data, error } = await supa
      .from("people")
      .select("work_email")
      .eq("work_email", e)
      .eq("is_sc_lock_override", true)
      .eq("status", "ACTIVE")
      .limit(1);
    if (error) {
      console.error(`[sc/admin] isScLockOverrideDb: ${error.message}`);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sc/admin] isScLockOverrideDb: ${msg}`);
    return false;
  }
}
