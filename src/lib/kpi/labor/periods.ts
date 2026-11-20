// src/lib/kpi/labor/periods.ts
//
// D2 hotfix H1 - one client-side period function, used everywhere.
//
// Train 2b: every function takes the fiscal year as an input. Period
// arithmetic reads the object's `periods` array; it does not re-derive
// dates by adding 28 days to a typed-in start. Out-of-year dates
// return null rather than guessing a neighbour year (this is a
// documented behaviour change from v1; see docs/KPI.md).
//
// Why client-side: `labor_actuals.period_no` is a stored column populated
// by the derive pipeline. The C6/C6.1 backfill rows (pre-2026-04-20)
// were inserted with period_no = null because they came from the
// Rippling report, not the derive pipeline that walks account_periods.
// Trusting the DB value collapses those weeks into an unlabeled "?"
// bucket that can't be expanded (state tracks period_no, and null
// keys don't route through Set membership as the user expects).

import type { FiscalYear } from "@/lib/kpi/shared/fiscalYear";

const MS_PER_DAY = 86400000;
const DAYS_PER_PERIOD = 28;

// Parse YYYY-MM-DD as a UTC date. UTC anchor is required because
// arithmetic between local Date objects across DST transitions loses an
// hour (spring forward) or gains one (fall back), and floor((diff)/86400000)
// gives 223 instead of 224 across a spring-forward boundary. This misplaces
// the current week by a period. Every parse-then-diff below uses UTC.
function parseISO(iso: any): any {
  if (typeof iso !== "string") return null;
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Return the fiscal period number (1..13) for a given ISO week_start,
// within the fiscal year `fy`. Returns null when the date falls outside
// fy's year (pre-fy.startISO or post-fy.endISO) - the caller decides
// whether to include such rows (usually: filed under "prior/next FY").
export function periodOf(weekStartISO: any, fy: FiscalYear): any {
  if (typeof weekStartISO !== "string") return null;
  const iso = weekStartISO.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  for (const p of fy.periods) {
    if (iso >= p.startISO && iso <= p.endISO) return p.period_no;
  }
  return null;
}

// Fiscal year integer for a given week_start, relative to `fy`.
// Returns fy.year when the date falls within fy. For dates outside
// fy's bounds this falls back to the calendar year +/- 1 so existing
// filing behaviour ("prior FY" / "next FY") is preserved.
export function fiscalYearOf(weekStartISO: any, fy: FiscalYear): any {
  if (typeof weekStartISO !== "string") return null;
  const iso = weekStartISO.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  if (iso >= fy.startISO && iso <= fy.endISO) return fy.year;
  if (iso < fy.startISO) return Number(iso.slice(0, 4));
  return Number(iso.slice(0, 4)) + 1;
}

// The start ISO for a given period_no inside `fy`.
export function periodStartISO(period_no: any, fy: FiscalYear): any {
  if (!Number.isInteger(period_no) || period_no < 1 || period_no > 13) return null;
  return fy.periods[period_no - 1].startISO;
}

// The end ISO for a given period_no inside `fy` (inclusive).
export function periodEndISO(period_no: any, fy: FiscalYear): any {
  if (!Number.isInteger(period_no) || period_no < 1 || period_no > 13) return null;
  return fy.periods[period_no - 1].endISO;
}

// Which period contains today's date within `fy`? Used for hero's
// suffix labeling of "this period" / "last period" when the user is
// on a preset. Returns null when today is outside fy.
export function currentPeriodNo(todayISO: any, fy: FiscalYear): any {
  return periodOf(todayISO, fy);
}

// R-93 ([name] 2026-09-09). A period enters "This year" only after it
// is BOTH closed AND at least one full week past its close. A period
// closing on Sunday enters on the second Monday after (day 8 forward).
// Rationale: a period that closed 2 days ago still has half its
// invoices arriving; scoring it flatters the year on incomplete cost.
// This is the This year half of the cost-completeness rule.
//
// Boundary: today - end > 7d. P9 ends 09-06 -> settled on 09-14
// (today - end = 8d). On 09-13 (today - end = 7d) still not settled.
//
// r93FytdEndISO(today, fy): the ISO date to use as the This year
// range end. Returns the last SETTLED period's end. Pre-P1-settle
// edge (never happens mid-season) returns null.
export function r93FytdEndISO(todayISO: any, fy: FiscalYear): any {
  const t = parseISO(todayISO);
  if (!t) return null;
  const cutoffMs = t.getTime() - 7 * MS_PER_DAY;
  const curP = periodOf(todayISO, fy) ?? 13;
  for (let p = Math.min(13, curP); p >= 1; p -= 1) {
    const endISO = periodEndISO(p, fy);
    if (!endISO) continue;
    const endMs = parseISO(endISO).getTime();
    if (endMs < cutoffMs) return endISO;
  }
  return null;
}

// The period that IS closed but NOT yet settled - the one whose
// existence needs naming on the This year status line ("P9 awaiting
// verification"). Returns the just-closed period_no when it hasn't
// yet crossed the R-93 boundary; null otherwise.
export function r93ExcludedPeriodNo(todayISO: any, fy: FiscalYear): any {
  const curP = periodOf(todayISO, fy);
  if (curP == null) return null;
  const priorP = curP - 1;
  if (priorP < 1) return null;
  const priorEnd = periodEndISO(priorP, fy);
  if (!priorEnd) return null;
  const cutoffMs = parseISO(todayISO).getTime() - 7 * MS_PER_DAY;
  const priorEndMs = parseISO(priorEnd).getTime();
  return priorEndMs < cutoffMs ? null : priorP;
}

// Range redesign 2026-09-03 (R-62). Small pure helper the RangeMenu
// picker (PR-A) and the planning view (PR-B) both consume so their
// notion of "what's clickable" cannot drift.
//
//   closed       -> ended before today (default, clickable)
//   running      -> contains today (amber, clickable)
//   next         -> the period after running (clickable - R-62)
//   not_started  -> every period after next (disabled)
export function periodPickerState(periodNo: any, todayISO: any, fy: FiscalYear): any {
  if (!Number.isInteger(periodNo) || periodNo < 1 || periodNo > 13) return null;
  const running = currentPeriodNo(todayISO, fy);
  if (running == null) return null;
  if (periodNo < running) return "closed";
  if (periodNo === running) return "running";
  if (periodNo === running + 1) return "next";
  return "not_started";
}

// Range redesign 2026-09-03 · item 1. The picker shows every period
// with its dates. "P5 · 04/20 – 05/17" instead of bare "P5". Same
// month/day slicing the command bar already uses.
export function periodDateShort(periodNo: any, fy: FiscalYear): any {
  const s = periodStartISO(periodNo, fy);
  const e = periodEndISO(periodNo, fy);
  if (!s || !e) return null;
  return `${s.slice(5, 7)}/${s.slice(8, 10)} – ${e.slice(5, 7)}/${e.slice(8, 10)}`;
}

// [name] ruling R-63 (2026-09-03). The Service Calendar is committed
// a week ahead; revenue counts complete weeks. Cost cannot follow -
// week 4 spend is not known on a Wednesday. So both sides stop at
// the end of the last complete week in the range. A week is complete
// when its end date is STRICTLY before today.
export function endOfLastCompleteWeek(rangeStartISO: any, rangeEndISO: any, todayISO: any, fy: FiscalYear): any {
  const weeks = weekStartsInRange(rangeStartISO, rangeEndISO, fy);
  if (weeks.length === 0 || !todayISO) return null;
  let last = null;
  for (let i = 0; i < weeks.length; i += 1) {
    const ws = weeks[i];
    const wStartMs = parseISO(ws).getTime();
    const weISO = new Date(wStartMs + 6 * MS_PER_DAY).toISOString().slice(0, 10);
    if (weISO < todayISO) {
      last = { weekNo: i + 1, weekStartISO: ws, weekEndISO: weISO };
    } else {
      break;
    }
  }
  if (!last) return null;
  return { effectiveEndISO: last.weekEndISO, ...last };
}

// V6-1 - week-of-period (1..4) for the given ISO date within its
// containing fiscal period. Used in the command bar fiscal context.
// Returns null when the date falls outside fy.
export function weekOfPeriod(dateISO: any, fy: FiscalYear): any {
  if (typeof dateISO !== "string") return null;
  const iso = dateISO.slice(0, 10);
  const p = periodOf(iso, fy);
  if (p == null) return null;
  const pStart = parseISO(fy.periods[p - 1].startISO);
  const d = parseISO(iso);
  if (!pStart || !d) return null;
  const withinPeriod = Math.floor((d.getTime() - pStart.getTime()) / MS_PER_DAY);
  const w = Math.floor(withinPeriod / 7) + 1;
  return w >= 1 && w <= 4 ? w : null;
}

// V6-3 - fiscal months (calendar month indexes, 0..11) that contain
// at least one fiscal week whose MONDAY falls inside the month.
// Fiscal weeks step exactly 7 days from fy.startISO; a week belongs
// to a month iff its Monday is in that month.
export function fiscalMonthsWithWeeks(fy: FiscalYear): any {
  const fyStart = parseISO(fy.startISO);
  if (!fyStart) return [];
  const buckets = new Map<any, any>();
  for (let i = 0; i < 52; i += 1) {
    const wStart = new Date(fyStart.getTime() + i * 7 * MS_PER_DAY);
    const key = `${wStart.getUTCFullYear()}-${wStart.getUTCMonth()}`;
    const cur = buckets.get(key) || {
      year: wStart.getUTCFullYear(),
      monthIndex: wStart.getUTCMonth(),
      weekCount: 0,
      firstMonday: null,
      lastMonday: null,
    };
    cur.weekCount += 1;
    const iso = wStart.toISOString().slice(0, 10);
    if (!cur.firstMonday) cur.firstMonday = iso;
    cur.lastMonday = iso;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a: any, b: any): any =>
    a.year - b.year || a.monthIndex - b.monthIndex
  );
}

// V6-4 - resolve a month selection (year + monthIndex) into a
// concrete { startISO, endISO } range that spans exactly the fiscal
// weeks whose Monday falls in that month.
export function rangeForFiscalMonth(year: any, monthIndex: any, fy: FiscalYear): any {
  const months = fiscalMonthsWithWeeks(fy);
  const m = months.find((mm: any): any => mm.year === year && mm.monthIndex === monthIndex);
  if (!m) return null;
  const lastMon = parseISO(m.lastMonday);
  if (!lastMon) return null;
  const endMs = lastMon.getTime() + 6 * MS_PER_DAY;
  const endISO = new Date(endMs).toISOString().slice(0, 10);
  return { startISO: m.firstMonday, endISO, weekCount: m.weekCount };
}

// Range PR-2 follow-up 2026-08-24. Calendar-month range, clamped to
// fiscal-year bounds.
export function rangeForCalendarMonth(year: any, monthIndex: any, fy: FiscalYear): any {
  const fyStart = parseISO(fy.startISO);
  const fyEnd   = parseISO(fy.endISO);
  if (!fyStart || !fyEnd) return null;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;

  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEnd   = new Date(Date.UTC(year, monthIndex + 1, 0));

  const clampedStart = monthStart < fyStart ? fyStart : monthStart;
  const clampedEnd   = monthEnd   > fyEnd   ? fyEnd   : monthEnd;

  if (clampedEnd < fyStart || clampedStart > fyEnd) return null;
  if (clampedStart > clampedEnd) return null;

  const startISO = clampedStart.toISOString().slice(0, 10);
  const endISO   = clampedEnd.toISOString().slice(0, 10);
  const spanDays = Math.round((clampedEnd.getTime() - clampedStart.getTime()) / MS_PER_DAY) + 1;
  return { startISO, endISO, spanDays };
}

// V6-3 - resolve a period selection into a { startISO, endISO } range.
export function rangeForPeriod(period_no: any, fy: FiscalYear): any {
  const s = periodStartISO(period_no, fy);
  const e = periodEndISO(period_no, fy);
  if (!s || !e) return null;
  return { startISO: s, endISO: e };
}

// V6-7 - inverse label inference.
export function inferRangeSelection(startISO: any, endISO: any, fy: FiscalYear): any {
  if (!startISO || !endISO) return null;
  for (let p = 1; p <= 13; p += 1) {
    const r = rangeForPeriod(p, fy);
    if (r && r.startISO === startISO && r.endISO === endISO) {
      return { kind: "period", value: p, label: `PERIOD ${p}` };
    }
  }
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  for (const m of fiscalMonthsWithWeeks(fy)) {
    const r = rangeForFiscalMonth(m.year, m.monthIndex, fy);
    if (r && r.startISO === startISO && r.endISO === endISO) {
      return { kind: "month", value: { year: m.year, monthIndex: m.monthIndex }, label: `${MONTHS[m.monthIndex]} ${m.year}` };
    }
  }
  return null;
}

// D2.3 - human-readable span the RANGE touches.
export function spanLabelForRange(rangeStartISO: any, rangeEndISO: any, todayISO: any, fy: FiscalYear): any {
  const weeks = weekStartsInRange(rangeStartISO, rangeEndISO, fy);
  if (weeks.length === 0) return null;
  const pFirst = periodOf(weeks[0], fy);
  const pLast  = periodOf(weeks[weeks.length - 1], fy);
  if (pFirst == null || pLast == null) return null;
  const base = pFirst === pLast ? `P${pFirst}` : `P${pFirst}-P${pLast}`;
  const toDate = todayISO && rangeEndISO && rangeEndISO === todayISO ? " to date" : "";
  return `${base}${toDate}`;
}

// kpi-2 - the ONE week-in-range enumerator. Same overlap semantics
// as the server-side actuals filter (`week_start <= end AND week_end
// >= start`). Fiscal weeks step exactly 7 days from fy.startISO.
export function weekStartsInRange(rangeStartISO: any, rangeEndISO: any, fy: FiscalYear): any {
  const rs = parseISO(rangeStartISO);
  const re = parseISO(rangeEndISO);
  const fyStart = parseISO(fy.startISO);
  if (!rs || !re || !fyStart || rs > re) return [];
  const rsMs = rs.getTime();
  const reMs = re.getTime();
  const fyMs = fyStart.getTime();
  const idxStart = Math.max(0, Math.floor((rsMs - 6 * MS_PER_DAY - fyMs) / (7 * MS_PER_DAY)));
  const out = [];
  for (let i = idxStart; ; i += 1) {
    const wStartMs = fyMs + i * 7 * MS_PER_DAY;
    if (wStartMs > reMs) break;
    const wEndMs = wStartMs + 6 * MS_PER_DAY;
    if (wEndMs >= rsMs) {
      out.push(new Date(wStartMs).toISOString().slice(0, 10));
    }
  }
  return out;
}
