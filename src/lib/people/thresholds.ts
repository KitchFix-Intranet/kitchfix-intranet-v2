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
