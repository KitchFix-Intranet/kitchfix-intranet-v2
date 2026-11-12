// People Portal thresholds. Single source for every "how long is
// too long" test in the surface. One constant, one helper, so the
// band warn and the card's per-row `late` flag can never drift.

// A pending request is `late` after this many whole days.
export const LATE_DAYS = 14;

// True when a submission timestamp is >= LATE_DAYS old. Uses the
// same whole-day floor as fmtDaysWaiting so "N days" and `late`
// agree across the surface.
export function isLate(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const days = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
  return days >= LATE_DAYS;
}

// Inbox cutover date. Anything decided BEFORE this date is treated
// as already-opened for every viewer, no matter what
// people_record_opens holds. This keeps old history out of Needs
// you and Just decided on day one - a Rejected row from June is
// not "new" just because nobody has clicked it yet. Pending rows
// are unaffected.
//
// Reset on cutover day.
export const UNREAD_SINCE = "2026-11-12";

// True when a decided row is "new enough" for the unread marker to
// apply. Pending rows are not decided and never match here (caller
// should only consult this for terminal statuses).
export function decidedAfterCutover(admin_action_at: string | null | undefined): boolean {
  if (!admin_action_at) return false;
  // String compare is safe: both sides are ISO timestamps; the
  // cutover is a date-only prefix. Anything from 2026-11-12T00:00
  // onward sorts greater than the "2026-11-12" literal.
  return admin_action_at >= UNREAD_SINCE;
}
