// 28-day Monday-first period layout from fiscal_periods.

export interface PeriodWindow {
  fiscalYear: number;
  periodNo: number;
  startIso: string;
  endIso: string;
  dates: string[];  // 28 ISO dates, Monday-first
  weeks: string[][]; // 4 arrays of 7 ISO dates
}

// Assert a 28-day window. A fiscal period that does not come out to 28
// days is a bad load and throws (loud, not silent). start_date is a
// Monday on every row checked.
export function makePeriodWindow(fiscalYear: number, periodNo: number, startIso: string, endIso: string): PeriodWindow {
  const dates = enumerate(startIso, endIso);
  if (dates.length !== 28) {
    throw new Error(`fiscal_periods ${fiscalYear}/${periodNo}: expected 28 days, got ${dates.length} (${startIso}..${endIso})`);
  }
  const weeks: string[][] = [];
  for (let w = 0; w < 4; w++) {
    weeks.push(dates.slice(w * 7, w * 7 + 7));
  }
  return { fiscalYear, periodNo, startIso, endIso, dates, weeks };
}

// UTC-only arithmetic so Chicago never shifts a day. The intranet's
// standing rule.
export function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`addDaysIso: expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}

function enumerate(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cur = startIso;
  while (cur <= endIso) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
    if (out.length > 60) throw new Error(`enumerate: runaway from ${startIso}..${endIso}`);
  }
  return out;
}

// Day-of-week from an ISO date, 0 = Monday. Pure.
export function dowOf(iso: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`dowOf: expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const js = d.getUTCDay();           // 0 = Sunday ... 6 = Saturday
  const mondayFirst = (js + 6) % 7;    // 0 = Monday
  return mondayFirst as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

// Find the fiscal period that holds the site's own today. Returns null
// when today is outside every period in the given year (shoulder of
// fiscal 2026 vs 2027, etc).
export function periodHoldingDate(
  windows: readonly { fiscalYear: number; periodNo: number; startIso: string; endIso: string }[],
  iso: string,
): { fiscalYear: number; periodNo: number } | null {
  for (const w of windows) {
    if (iso >= w.startIso && iso <= w.endIso) {
      return { fiscalYear: w.fiscalYear, periodNo: w.periodNo };
    }
  }
  return null;
}
