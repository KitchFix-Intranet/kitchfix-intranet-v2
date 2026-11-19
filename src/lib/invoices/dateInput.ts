// Date input parsing for Capture. Pure.
//
// Three ways in (§6):
//   1. "MMDDYYYY"       (8 digits typed, no punctuation)
//   2. "MM/DD/YYYY"     (slashes, as the sheet typed it)
//   3. a calendar pick  (already-ISO string passed through)
//
// We never guess the year. A two-digit year is rejected.
//
// Returns an ISO date-only string (`YYYY-MM-DD`) or `null` when the
// input is not a valid date. Validity checked against JS Date in
// UTC; the result is a date-only string so `src/lib/fmt.ts` can
// render it Chicago-safely (date-only path).

export interface DateParseResult {
  iso: string | null;              // YYYY-MM-DD or null
  future: boolean;                 // true when the date is strictly after today (Chicago)
  moreThan60DaysBack: boolean;     // true when ISO is >= 61 days before today
}

const CHI = "America/Chicago";

function todayParts(now: Date = new Date()): { y: number; m: number; d: number } {
  const bits = new Intl.DateTimeFormat("en-US", {
    timeZone: CHI, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { y: Number(bits.year), m: Number(bits.month), d: Number(bits.day) };
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Round-trip via UTC: if constructing the UTC date at Y/M/D and
  // reading back the same Y/M/D, it's a real calendar date.
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

// Day index for Chicago date (y, m, d). Days since 1970-01-01 UTC at
// midnight of that calendar date. Used to compute "days back".
function dayIndex(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / (24 * 60 * 60 * 1000));
}

export function parseDateInput(raw: string | null | undefined, now: Date = new Date()): DateParseResult {
  const empty: DateParseResult = { iso: null, future: false, moreThan60DaysBack: false };
  if (!raw) return empty;
  const s = String(raw).trim();
  if (!s) return empty;

  let y: number | null = null, m: number | null = null, d: number | null = null;

  // ISO YYYY-MM-DD (calendar pick path). Accept strictly-10-char form.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    y = Number(s.slice(0, 4)); m = Number(s.slice(5, 7)); d = Number(s.slice(8, 10));
  }
  // MM/DD/YYYY. Reject MM/DD/YY (no guessing).
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split("/");
    m = Number(mm); d = Number(dd); y = Number(yy);
  }
  // MMDDYYYY. 8 digits, no punctuation.
  else if (/^\d{8}$/.test(s)) {
    m = Number(s.slice(0, 2));
    d = Number(s.slice(2, 4));
    y = Number(s.slice(4, 8));
  }
  else {
    return empty;
  }

  if (y === null || m === null || d === null || !isValidYMD(y, m, d)) return empty;

  const t = todayParts(now);
  const today = dayIndex(t.y, t.m, t.d);
  const picked = dayIndex(y, m, d);
  const future = picked > today;
  const moreThan60DaysBack = today - picked > 60;

  return { iso: `${y}-${pad2(m)}-${pad2(d)}`, future, moreThan60DaysBack };
}
