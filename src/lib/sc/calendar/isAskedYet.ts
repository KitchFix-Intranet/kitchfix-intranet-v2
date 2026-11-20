// isAskedYet(input) - is the operator asked about this week yet?
//
// A site that has never submitted a week in V2 is not "late" on a week
// that ended before its today, until fiscal 2027 begins (2026-12-28).
// Three callers all have to agree on the answer so the Sites board,
// the calendar home and the week check never disagree on the verb.
//
// This rule only changes the DISPLAY word. The server-side submit
// rules (checkWeekSubmittable) do not read this function; its only
// job is "do we call this week late on a screen".
//
// Kevin ruling 2026-11-20. Ends 2026-12-28 (fiscal 2027 begins).

export interface IsAskedYetInput {
  // Chicago-stable site today, YYYY-MM-DD.
  today: string;
  // Any sc_week_finalize row for this account whose status is not
  // 'reverted'. Keyed per account; callers feed a bulk-read lookup.
  anyFinalizeRowEver: boolean;
  // The week's unit end (Sunday for weekly, second-week Sunday for
  // biweekly). YYYY-MM-DD.
  unitEndIso: string;
  // Fiscal-2027 cutover. Parameter so tests can pin it; the default
  // matches fiscal_periods for FY27 period 1 start.
  cutoverIso?: string;
}

const DEFAULT_CUTOVER = "2026-12-28";

// Shared across the three surfaces (calendar, sites board, week
// check) so a never-submitted site cannot read "still open" on one
// and "projected" on another. Takes the raw inputs and returns the
// effective flag to feed into resolveDayState + resolveWeekState.
//
// Semantics: when `isAskedYet` is false, the week is NOT asked
// about yet, so the display behaves as if the unit has not ended.
export function effectiveUnitEndedBeforeSiteToday(
  today: string,
  unitEndIso: string,
  anyFinalizeRowEver: boolean,
  cutoverIso?: string,
): boolean {
  const asked = isAskedYet({ today, unitEndIso, anyFinalizeRowEver, cutoverIso });
  if (!asked) return false;
  return unitEndIso < today;
}

// Returns true when this week IS a week the operator is being asked
// about (i.e. render as late / still-open). Returns false when the
// week is still exempt (render as projected).
export function isAskedYet(input: IsAskedYetInput): boolean {
  const cutover = input.cutoverIso ?? DEFAULT_CUTOVER;

  if (!input.today) {
    throw new Error("isAskedYet: today required");
  }

  // On or after cutover: every calendar site is asked.
  if (input.today >= cutover) return true;

  // Before cutover + any real finalize history: asked.
  if (input.anyFinalizeRowEver) return true;

  // Before cutover + never-submitted + unit still open: not asked yet
  // (there is no "late" question until the unit ends).
  if (input.unitEndIso >= input.today) return false;

  // Before cutover + never-submitted + unit ended: still not asked.
  return false;
}
