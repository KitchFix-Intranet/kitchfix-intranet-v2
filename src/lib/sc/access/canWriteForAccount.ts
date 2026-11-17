// canWriteForAccount - one shared helper for every write path that
// touches sc_daily_actuals or sc_week_finalize on behalf of a viewer.
//
// Kevin ruling 2026-11-17: regional directors are flagged corp and
// are intentionally full-office. The rule is simply "corp sees all,
// salaried sees their own". No region scoping.
//
// Not called today because /service is owner-only; wired now so the
// day-form save enforces the right rule the day the staff sign-in
// switch flips, and so the submit train's canSubmitForAccount can
// delegate to this helper in a follow-up cleanup (no third copy).

import type { ViewerLite } from "@/lib/sc/calendar/types";

export type WriteDenial =
  | { ok: false; code: "NOT_AUTHORIZED"; message: string };

export function canWriteForAccount(
  viewer: ViewerLite,
  accountKey: string,
): { ok: true } | WriteDenial {
  if (viewer.is_corp) return { ok: true };
  if (viewer.is_salaried && viewer.account_key === accountKey) return { ok: true };
  return {
    ok: false,
    code: "NOT_AUTHORIZED",
    message: "This viewer may not write for this site.",
  };
}
