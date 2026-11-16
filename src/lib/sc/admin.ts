// Service Calendar lane · Admin seam.
//
// One export: `isScLockOverrideDb(email)`. True when the `people`
// table has any row for that work email with `is_sc_lock_override`
// true. False for no email, no matching row, or any failure. It
// never throws.
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

export async function isScLockOverrideDb(email: string | null | undefined): Promise<boolean> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return false;
  try {
    const supa = getServiceClient();
    const { data, error } = await supa
      .from("people")
      .select("work_email")
      .eq("work_email", e)
      .eq("is_sc_lock_override", true)
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
