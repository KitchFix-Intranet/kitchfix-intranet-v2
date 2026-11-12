// Dates (R-PP59, pin 5 2026-11-11):
//   - short in rows: "Nov 9"
//   - full on the card: "Nov 9, 2026"
//   - "N days" is ONLY for how long a request has waited
//   - No "N days ago" helper exists (and this file does not export one).
//
// Chicago TZ for display. The ISO strings go through a parser that
// does not mis-day a bare YYYY-MM-DD (see docs/GOTCHAS.md #4).

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parsePartsFromISO(iso: string): { y: number; m: number; d: number } | null {
  const s = (iso || "").trim();
  if (!s) return null;
  // Date-only "YYYY-MM-DD": parse the parts directly (no TZ shift).
  const ymd = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

// "Nov 9" - used in rows and in history row dates.
export function fmtShort(iso: string | null | undefined): string {
  const p = iso ? parsePartsFromISO(iso) : null;
  if (!p) return "-";
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}`;
}

// "Nov 9, 2026" - used on the card and in title attributes.
export function fmtFull(iso: string | null | undefined): string {
  const p = iso ? parsePartsFromISO(iso) : null;
  if (!p) return "-";
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}`;
}

// T3.1 fix 5 (2026-11-13). Date range formatter for the inbox:
//   same day              -> "Sep 15"
//   same month different d -> "Oct 20 to 22"
//   different months       -> "Sep 29 to Oct 1"
//   missing end or start   -> falls back to fmtShort(start || end)
// Never "Sep 15 - Sep 15" and never a hyphen when a range is given.
export function fmtRangeShort(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const start = startIso ? parsePartsFromISO(startIso) : null;
  const end = endIso ? parsePartsFromISO(endIso) : null;
  if (start && end) {
    if (start.m === end.m && start.d === end.d && start.y === end.y) return `${MONTHS_SHORT[start.m - 1]} ${start.d}`;
    if (start.m === end.m && start.y === end.y) return `${MONTHS_SHORT[start.m - 1]} ${start.d} to ${end.d}`;
    return `${MONTHS_SHORT[start.m - 1]} ${start.d} to ${MONTHS_SHORT[end.m - 1]} ${end.d}`;
  }
  return fmtShort(startIso ?? endIso);
}

// "N days" - ONLY for how long a request has waited. Takes an ISO
// timestamp (submitted_at) and returns the integer-day delta from
// today, formatted as "<N> days" or "today"/"1 day".
export function fmtDaysWaiting(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const days = Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}
