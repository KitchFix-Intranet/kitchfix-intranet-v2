// src/lib/kpi/screen/laborLedger.ts
//
// Train 2d-1. REWRITE from v1:
//   src/app/kpi/overview/components/LaborLedger.js (290 lines).
//   src/app/kpi/labor/components/WeekTable.js (band + week + worker
//   row shape, column visibility rules, salary subtraction).
//
// LaborLedger is a thin fold on top of the aggregate math (moved
// whole in laborAggregate.ts). The ledger's screen model carries:
//
//   render        - true iff the labor payload is present + the board
//                   applies to this range
//   header_summary - "N hrs · $A" the collapsed trigger shows
//   week_rows     - per-week row for the inside-fold table, with the
//                   full per-pay-type breakdown (Reg/OT/DT/Prem/Salary)
//                   and 2-decimal dollar + hour figures
//   period_bands  - per-period aggregate band row with the same
//                   breakdown (what the DOM renders when the week table
//                   is collapsed to periods)
//   grand         - the sum row (also with the breakdown)
//
// Each week row contains:
//   week_start, week_end, period_no, fiscal_year, state, flag_state,
//   hours_regular/overtime/double_time/premium_other (2dp),
//   dollars_regular/overtime/double_time/premium_other (2dp),
//   salary_amount (2dp)             — sum of actuals rows flagged
//                                     `salaried:true` on this week
//   net_dollars_regular              — dollars_regular - salary_amount
//                                     (what the DOM Reg $ cell shows
//                                     because dollars_regular arrives
//                                     salary-inclusive)
//   total_dollars                   — amount (reg+ot+dt+prem, which is
//                                     already salary-inclusive; this
//                                     matches the DOM Total cell)
//   budget, variance_dollars, verdict, unapproved_hours, worker_rows.
//
// Scope: closed single-period AND this-year ranges (train 2d-1).
// Running-period (`single_period_in_progress`) is out of scope.

import type { FiscalYear } from "@/lib/kpi/shared/fiscalYear";
import {
  buildFilteredActuals,
  buildWeekAggregates,
  buildGrouped,
  buildGrand,
  buildWorkerRangeTotals,
  buildWorkerRoster,
  periodsInBoardWeeks,
} from "./laborAggregate";
import { flagForV42State } from "./weekFlag";
import {
  fmtHrs,
  fmtHrsRounded,
  formatMoneyWhole,
} from "./formatting";

export type LaborVerdict = "good" | "bad" | "even" | "none";

// 2-decimal money formatter, matching v1 labor/lib/formatting.js:fmt$.
// Null/NaN -> null (callers render "—" via their own branch).  Always
// prints two decimals so a figure like $1,234.56 is stable across
// locales.
function formatMoneyCents(n: any): string | null {
  if (n == null || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  const abs = Math.abs(v);
  const s =
    "$" +
    abs.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return v < 0 ? "-" + s : s;
}

export type LaborWorkerRow = {
  worker_id: string | null;
  display_name: string | null;
  number: number | null;
  title: string | null;
  salaried: boolean;
  hours_regular: number;
  hours_overtime: number;
  hours_double_time: number;
  hours_premium_other: number;
  dollars_regular: number;
  dollars_overtime: number;
  dollars_double_time: number;
  dollars_premium_other: number;
  total_dollars: number;
};

export type LaborWeekRow = {
  week_start: string;
  week_end: string;
  period_no: number | null;
  fiscal_year: number;
  // Legacy aggregate scalars (kept for existing consumers + tests).
  hours: number;                      // reg + ot + double
  dollars: number;                    // amount (settled)
  // Per-pay-type hours (2dp precision preserved end-to-end).
  hours_regular: number;
  hours_overtime: number;
  hours_double_time: number;
  hours_premium_other: number;
  // Per-pay-type dollars (2dp precision preserved end-to-end).
  // dollars_regular is salary-INCLUSIVE because the labor route folds
  // salary rows into regular dollars on derive (shapeSalaryRow sets
  // dollars_regular = amount, salaried:true).  The DOM Reg $ cell
  // subtracts the salary slice back out so the row's Reg $ reads the
  // hourly-only regular pay; net_dollars_regular is that subtraction.
  dollars_regular: number;
  dollars_overtime: number;
  dollars_double_time: number;
  dollars_premium_other: number;
  salary_amount: number;               // sum of `salaried:true` rows
  net_dollars_regular: number;         // dollars_regular - salary_amount
  total_dollars: number;               // amount (period-row Total cell)
  // Budget / verdict / status shape (unchanged).
  budget: number | null;              // batr (budget_at_this_week_revenue)
  unapproved_hours: number;
  unpriced_hours: number;
  variance_dollars: number | null;    // dollars - budget
  verdict: LaborVerdict;
  state: "closed" | "in_progress" | "not_started" | "unknown";
  flag_state: "s1" | "s2" | "s3a" | "s3b" | null;
  flag_label: string | null;
  worker_rows: LaborWorkerRow[];
};

export type LaborPeriodBand = {
  period_no: number;
  fiscal_year: number;
  weeks_in_band: number;
  // Per-pay-type aggregates for the band (sum over the band's weeks).
  hours_regular: number;
  hours_overtime: number;
  hours_double_time: number;
  hours_premium_other: number;
  dollars_regular: number;              // salary-inclusive, same
                                        // convention as LaborWeekRow
  dollars_overtime: number;
  dollars_double_time: number;
  dollars_premium_other: number;
  salary_amount: number;
  net_dollars_regular: number;          // dollars_regular - salary_amount
  total_dollars: number;                // sum(amount) over the band
  // Budget + verdict (sum of started-week batr per period).
  budget: number | null;
  variance_dollars: number | null;
  verdict: LaborVerdict;
};

export type LaborGrandRow = {
  hours: number;
  dollars: number;
  budget: number | null;
  variance_dollars: number | null;
  // Per-pay-type aggregates (parallel to LaborPeriodBand).
  hours_regular: number;
  hours_overtime: number;
  hours_double_time: number;
  hours_premium_other: number;
  dollars_regular: number;
  dollars_overtime: number;
  dollars_double_time: number;
  dollars_premium_other: number;
  salary_amount: number;
  net_dollars_regular: number;
  total_dollars: number;
};

export type LaborLedgerModel = {
  render: boolean;
  header_summary: { hours: number; dollars: number } | null;
  weeks: LaborWeekRow[];
  period_bands: LaborPeriodBand[];
  grand: LaborGrandRow | null;
};

function verdictFromDelta(delta: number | null): LaborVerdict {
  if (delta == null) return "none";
  if (Math.abs(delta) < 1) return "even";
  return delta > 0 ? "bad" : "good";
}

type BuildLaborLedgerOpts = {
  labor: any;                          // response from /api/kpi/labor
  rangeSelection: any;                 // { kind: "period", value: n } etc.
  start: string;
  end: string;
  today: string;
  fy: FiscalYear;
};

export function buildLaborLedger(opts: BuildLaborLedgerOpts): LaborLedgerModel {
  const labor = opts.labor;
  if (!labor || !labor.actuals || labor.board?.applies === false) {
    return {
      render: false,
      header_summary: null,
      weeks: [],
      period_bands: [],
      grand: null,
    };
  }
  const filtered = buildFilteredActuals(labor.actuals, null);
  const excluded = new Set<string>(labor.aggregate_excluded_members || []);
  const weekAggs = buildWeekAggregates(
    filtered,
    excluded,
    labor.board?.weeks,
    opts.fy,
  );
  const grouped = buildGrouped(weekAggs, opts.rangeSelection, labor.board, opts.fy);
  const grand = buildGrand(
    grouped,
    opts.today,
    labor.board?.avg_rate,
    opts.fy,
  );

  // Per-week salary dollar total.  Walk the full `actuals` list
  // (post-filter), accumulating `amount` where `salaried` is truthy.
  // Mirrors WeekTable.js:538's `salaryAmountsByWeek` useMemo.  This
  // is the ONE source of truth for the Reg $ / Salary split the DOM
  // renders.
  const salaryAmountsByWeek = new Map<string, number>();
  for (const r of filtered || []) {
    if (!r?.salaried) continue;
    const key = r.week_start;
    if (!key) continue;
    salaryAmountsByWeek.set(
      key,
      (salaryAmountsByWeek.get(key) || 0) + Number(r.amount || 0),
    );
  }

  // --- Per-worker helper -------------------------------------------
  // Shape worker-row payload rows for a given week into the
  // LaborWorkerRow layout.  Mirrors WeekTable.js:workerChildrenForWeek
  // minus the OTTag + anomaly fields (which are not figure-bearing in
  // the DOM compare set).
  function shapeWorkerRows(weekRaw: any): LaborWorkerRow[] {
    const workers = labor.workers || {};
    const rows: any[] = Array.isArray(weekRaw?.worker_rows)
      ? weekRaw.worker_rows
      : [];
    return rows
      .slice()
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
      .map((r: any): LaborWorkerRow => ({
        worker_id: r.worker_id ?? null,
        display_name: workers?.[r.worker_id]?.display_name ?? null,
        number: workers?.[r.worker_id]?.number ?? null,
        title: workers?.[r.worker_id]?.title ?? null,
        salaried: Boolean(r.salaried),
        hours_regular: Number(r.hours_regular || 0),
        hours_overtime: Number(r.hours_overtime || 0),
        hours_double_time: Number(r.hours_double_time || 0),
        hours_premium_other: Number(r.hours_premium_other || 0),
        dollars_regular: Number(r.dollars_regular || 0),
        dollars_overtime: Number(r.dollars_overtime || 0),
        dollars_double_time: Number(r.dollars_double_time || 0),
        dollars_premium_other: Number(r.dollars_premium_other || 0),
        total_dollars: Number(r.amount || 0),
      }));
  }

  // --- Per-week rows -----------------------------------------------
  const boardWeeks = Array.isArray(labor.board?.weeks)
    ? labor.board.weeks
    : [];
  const boardByStart = new Map(
    boardWeeks.map((w: any) => [w.week_start, w]),
  );
  const rows: LaborWeekRow[] = [];
  for (const g of grouped) {
    for (const w of g.weeks || []) {
      const bw = boardByStart.get(w.week_start) as any;
      const batr =
        w.budget_at_this_week_revenue != null
          ? Number(w.budget_at_this_week_revenue)
          : null;
      const dollars = Number(w.amount || 0);
      const hours =
        Number(w.hours_regular || 0) +
        Number(w.hours_overtime || 0) +
        Number(w.hours_double_time || 0);
      const unapproved = Number(w.draft_hours || 0);
      const unpriced = Number(w.hours_without_dollars || 0);
      const variance = batr != null ? dollars - batr : null;
      const state = (bw?.state as any) ?? "unknown";
      const isClosed = state === "closed";
      const flag = flagForV42State(w, isClosed);
      const dollars_regular = Number(w.dollars_regular || 0);
      const dollars_overtime = Number(w.dollars_overtime || 0);
      const dollars_double_time = Number(w.dollars_double_time || 0);
      const dollars_premium_other = Number(w.dollars_premium_other || 0);
      const salary_amount = Number(salaryAmountsByWeek.get(w.week_start) || 0);
      const net_dollars_regular = dollars_regular - salary_amount;
      rows.push({
        week_start: w.week_start,
        week_end: w.week_end,
        period_no: g.period_no ?? null,
        fiscal_year: g.fiscal_year,
        hours,
        dollars,
        hours_regular: Number(w.hours_regular || 0),
        hours_overtime: Number(w.hours_overtime || 0),
        hours_double_time: Number(w.hours_double_time || 0),
        hours_premium_other: Number(w.hours_premium_other || 0),
        dollars_regular,
        dollars_overtime,
        dollars_double_time,
        dollars_premium_other,
        salary_amount,
        net_dollars_regular,
        total_dollars: dollars,
        budget: batr,
        unapproved_hours: unapproved,
        unpriced_hours: unpriced,
        variance_dollars: variance,
        verdict: verdictFromDelta(variance),
        state,
        flag_state: flag?.state ?? null,
        flag_label: flag?.label ?? null,
        worker_rows: shapeWorkerRows(w),
      });
    }
  }
  // Sort by week_start ascending for display.
  rows.sort((a, b) => a.week_start.localeCompare(b.week_start));

  // --- Per-period bands --------------------------------------------
  // v1 WeekTable.js:periodTotals aggregates each group's weeks into
  // a band row.  Multi-period ranges drop the running period from
  // the displayed bands (displayPeriodTotals at :714); we mirror the
  // same filter so the model never emits a band the DOM wouldn't show.
  const bands: LaborPeriodBand[] = [];
  const boardWeeksByPeriod = new Map<number, any[]>();
  for (const bw of boardWeeks) {
    const pn = (bw as any)?.period_no;
    if (pn == null) continue;
    if (!boardWeeksByPeriod.has(pn)) boardWeeksByPeriod.set(pn, []);
    boardWeeksByPeriod.get(pn)!.push(bw);
  }
  const multi = grouped.length > 1;
  // A "running" period band is one whose period_no bounds contain today.
  // Mirrors WeekTable.js:isPeriodInProgress.  We approximate using the
  // group's period_no boundaries derived from the fy table.
  const todayISO = opts.today;
  function isPeriodInProgress(groupPeriodNo: number): boolean {
    const p = opts.fy.periods.find((pp) => pp.period_no === groupPeriodNo);
    if (!p) return false;
    return p.startISO <= todayISO && todayISO <= p.endISO;
  }
  for (const g of grouped) {
    if (g.groupHint?.kind !== "period") continue;
    // Keep zero-labor bands: v1 WeekTable renders them as rows with
    // "-" across the dollar cells, but the grand-total row still
    // counts them toward "TOTAL · N PERIODS · M WEEKS".  Skipping
    // here under-reported the period count on FYTD cases where the
    // account had some empty periods (e.g. S2 CIN-KY).  2026-11-20
    // strict-compare fix.
    if (multi && isPeriodInProgress(g.period_no)) continue;
    let hrsReg = 0, hrsOT = 0, hrsDT = 0, hrsPr = 0;
    let dollReg = 0, dollOT = 0, dollDT = 0, dollPr = 0, amt = 0;
    let salary = 0;
    for (const w of g.weeks || []) {
      hrsReg += Number(w.hours_regular || 0);
      hrsOT += Number(w.hours_overtime || 0);
      hrsDT += Number(w.hours_double_time || 0);
      hrsPr += Number(w.hours_premium_other || 0);
      dollReg += Number(w.dollars_regular || 0);
      dollOT += Number(w.dollars_overtime || 0);
      dollDT += Number(w.dollars_double_time || 0);
      dollPr += Number(w.dollars_premium_other || 0);
      amt += Number(w.amount || 0);
      salary += Number(salaryAmountsByWeek.get(w.week_start) || 0);
    }
    // Period budget: sum of started-week batr per Kevin's rule
    // (WeekTable.js:617, "no row displays a comparison against a
    // budget for a week that has not begun").  g.period_budget_total
    // is already pinned by buildGrouped for period groups.
    const periodBudget =
      g.period_budget_total != null ? Number(g.period_budget_total) : null;
    const variance = periodBudget != null ? amt - periodBudget : null;
    bands.push({
      period_no: g.period_no,
      fiscal_year: g.fiscal_year,
      // Zero-labor bands still carry the canonical period week count
      // (4 wks) so the grand-total "· M WEEKS" label is correct.
      weeks_in_band: g.weeks.length > 0 ? g.weeks.length : (g.weeks_in_period ?? 4),
      hours_regular: hrsReg,
      hours_overtime: hrsOT,
      hours_double_time: hrsDT,
      hours_premium_other: hrsPr,
      dollars_regular: dollReg,
      dollars_overtime: dollOT,
      dollars_double_time: dollDT,
      dollars_premium_other: dollPr,
      salary_amount: salary,
      net_dollars_regular: dollReg - salary,
      total_dollars: amt,
      budget: periodBudget,
      variance_dollars: variance,
      verdict: verdictFromDelta(variance),
    });
  }

  // --- Header summary (v1 LaborLedger.headerSummary) ---------------
  let headerSummary: { hours: number; dollars: number } | null = null;
  if (grand) {
    const totalHrs =
      (grand.hours_regular || 0) +
      (grand.hours_overtime || 0) +
      (grand.hours_double_time || 0);
    const totalAmt = grand.amount || 0;
    if (totalHrs > 0 || totalAmt > 0) {
      headerSummary = { hours: totalHrs, dollars: totalAmt };
    }
  }

  // --- Grand row ---------------------------------------------------
  // Band-level salary accumulator mirrors WeekTable.js:grandSalary;
  // multi-period ranges drop the running-period band from the sum,
  // single-period ranges include it.
  let grandSalary = 0;
  for (const b of bands) grandSalary += b.salary_amount;
  // Grand budget: sum of band budgets.
  let grandBudget: number | null = null;
  let grandBudgetAny = false;
  for (const b of bands) {
    if (b.budget != null) {
      grandBudget = (grandBudget ?? 0) + b.budget;
      grandBudgetAny = true;
    }
  }
  const grandRow: LaborGrandRow | null = grand
    ? {
        hours:
          (grand.hours_regular || 0) +
          (grand.hours_overtime || 0) +
          (grand.hours_double_time || 0),
        dollars: grand.amount || 0,
        budget: grandBudgetAny ? grandBudget : null,
        variance_dollars:
          grandBudgetAny && grandBudget != null
            ? (grand.amount || 0) - grandBudget
            : null,
        hours_regular: grand.hours_regular || 0,
        hours_overtime: grand.hours_overtime || 0,
        hours_double_time: grand.hours_double_time || 0,
        hours_premium_other: grand.hours_premium_other || 0,
        dollars_regular: grand.dollars_regular || 0,
        dollars_overtime: grand.dollars_overtime || 0,
        dollars_double_time: grand.dollars_double_time || 0,
        dollars_premium_other: grand.dollars_premium_other || 0,
        salary_amount: grandSalary,
        net_dollars_regular: (grand.dollars_regular || 0) - grandSalary,
        total_dollars: grand.amount || 0,
      }
    : null;

  // Keep these calls so the unused-import warnings don't fire - the
  // raw labor payload still carries them if a downstream consumer
  // (e.g. a probe) wants them.
  void buildWorkerRoster;
  void buildWorkerRangeTotals;
  void periodsInBoardWeeks;

  return {
    render: true,
    header_summary: headerSummary,
    weeks: rows,
    period_bands: bands,
    grand: grandRow,
  };
}

// --- Formatter ----------------------------------------------------

export type LaborWorkerRowDisplay = {
  worker_id: string | null;
  display_name: string | null;
  number: number | null;
  title: string | null;
  salaried: boolean;
  hours_regular_display: string | null;
  hours_overtime_display: string | null;
  hours_double_time_display: string | null;
  hours_premium_other_display: string | null;
  dollars_regular_display: string | null;
  dollars_overtime_display: string | null;
  dollars_double_time_display: string | null;
  dollars_premium_other_display: string | null;
  total_dollars_display: string | null;
};

export type LaborWeekRowDisplay = {
  week_start: string;
  week_end: string;
  period_no: number | null;
  // Legacy aggregate displays (kept for back-compat).
  hours_display: string | null;
  dollars_display: string | null;
  budget_display: string | null;
  unapproved_display: string | null;
  variance_display: string | null;
  verdict: LaborVerdict;
  state: string;
  flag_label: string | null;
  // Per-pay-type 2dp displays (new, matching WeekTable render).  Each
  // field is null if the underlying hours figure is below the 0.004
  // render threshold v1 uses to show "–" on the cell.
  hours_regular_display: string | null;
  hours_overtime_display: string | null;
  hours_double_time_display: string | null;
  hours_premium_other_display: string | null;
  net_dollars_regular_display: string | null;    // Reg $ column
  dollars_overtime_display: string | null;
  dollars_double_time_display: string | null;
  dollars_premium_other_display: string | null;
  salary_display: string | null;
  total_display: string | null;
  worker_rows: LaborWorkerRowDisplay[];
};

export type LaborPeriodBandDisplay = {
  period_no: number;
  fiscal_year: number;
  weeks_in_band: number;
  // Hours displays (2dp, suffix in the UI, not the model).
  hours_regular_display: string | null;
  hours_overtime_display: string | null;
  hours_double_time_display: string | null;
  hours_premium_other_display: string | null;
  // Dollar displays (2dp).  Each field is null when the matching
  // hours cell is below the render threshold.
  net_dollars_regular_display: string | null;
  dollars_overtime_display: string | null;
  dollars_double_time_display: string | null;
  dollars_premium_other_display: string | null;
  salary_display: string | null;
  total_display: string | null;
  // Budget / verdict.
  budget_display: string | null;
  variance_display: string | null;
  verdict: LaborVerdict;
};

export type LaborGrandDisplay = {
  hours_display: string | null;
  dollars_display: string | null;
  budget_display: string | null;
  variance_display: string | null;
  // Per-pay-type 2dp displays.
  hours_regular_display: string | null;
  hours_overtime_display: string | null;
  hours_double_time_display: string | null;
  hours_premium_other_display: string | null;
  net_dollars_regular_display: string | null;
  dollars_overtime_display: string | null;
  dollars_double_time_display: string | null;
  dollars_premium_other_display: string | null;
  salary_display: string | null;
  total_display: string | null;
};

export type LaborLedgerDisplay = {
  render: boolean;
  header_summary_display: string | null;
  weeks: LaborWeekRowDisplay[];
  period_bands: LaborPeriodBandDisplay[];
  grand: LaborGrandDisplay | null;
};

// 0.004 is v1's visible-cell threshold (WeekTable.js lines 1246/1251
// /1255/1259).  Hour cells below this render as "–" and the paired
// dollar cell goes "–" too.
const HRS_THRESHOLD = 0.004;
// 0.005 is v1's salary-cell threshold (WeekTable.js:1263); a salary
// slice of a fraction of a cent isn't a figure.
const SALARY_THRESHOLD = 0.005;

function shapeWorkerDisplay(r: LaborWorkerRow): LaborWorkerRowDisplay {
  return {
    worker_id: r.worker_id,
    display_name: r.display_name,
    number: r.number,
    title: r.title,
    salaried: r.salaried,
    hours_regular_display:
      r.hours_regular > HRS_THRESHOLD ? fmtHrs(r.hours_regular) : null,
    hours_overtime_display:
      r.hours_overtime > HRS_THRESHOLD ? fmtHrs(r.hours_overtime) : null,
    hours_double_time_display:
      r.hours_double_time > HRS_THRESHOLD ? fmtHrs(r.hours_double_time) : null,
    hours_premium_other_display:
      r.hours_premium_other > HRS_THRESHOLD
        ? fmtHrs(r.hours_premium_other)
        : null,
    dollars_regular_display:
      r.hours_regular > HRS_THRESHOLD ? formatMoneyCents(r.dollars_regular) : null,
    dollars_overtime_display:
      r.hours_overtime > HRS_THRESHOLD ? formatMoneyCents(r.dollars_overtime) : null,
    dollars_double_time_display:
      r.hours_double_time > HRS_THRESHOLD
        ? formatMoneyCents(r.dollars_double_time)
        : null,
    dollars_premium_other_display:
      r.hours_premium_other > HRS_THRESHOLD
        ? formatMoneyCents(r.dollars_premium_other)
        : null,
    total_dollars_display: formatMoneyCents(r.total_dollars),
  };
}

export function formatLaborLedger(m: LaborLedgerModel): LaborLedgerDisplay {
  if (!m.render) {
    return {
      render: false,
      header_summary_display: null,
      weeks: [],
      period_bands: [],
      grand: null,
    };
  }
  const header_summary_display = m.header_summary
    ? `${fmtHrsRounded(m.header_summary.hours)} hrs · ${formatMoneyWhole(m.header_summary.dollars)}`
    : null;

  const weeks: LaborWeekRowDisplay[] = m.weeks.map((r) => ({
    week_start: r.week_start,
    week_end: r.week_end,
    period_no: r.period_no,
    hours_display: fmtHrs(r.hours),
    dollars_display: formatMoneyWhole(r.dollars),
    budget_display: formatMoneyWhole(r.budget),
    unapproved_display:
      r.unapproved_hours > HRS_THRESHOLD ? fmtHrs(r.unapproved_hours) : null,
    variance_display: formatMoneyWhole(r.variance_dollars),
    verdict: r.verdict,
    state: r.state,
    flag_label: r.flag_label,
    hours_regular_display:
      r.hours_regular > HRS_THRESHOLD ? fmtHrs(r.hours_regular) : null,
    hours_overtime_display:
      r.hours_overtime > HRS_THRESHOLD ? fmtHrs(r.hours_overtime) : null,
    hours_double_time_display:
      r.hours_double_time > HRS_THRESHOLD ? fmtHrs(r.hours_double_time) : null,
    hours_premium_other_display:
      r.hours_premium_other > HRS_THRESHOLD
        ? fmtHrs(r.hours_premium_other)
        : null,
    net_dollars_regular_display:
      r.hours_regular > HRS_THRESHOLD
        ? formatMoneyCents(r.net_dollars_regular)
        : null,
    dollars_overtime_display:
      r.hours_overtime > HRS_THRESHOLD
        ? formatMoneyCents(r.dollars_overtime)
        : null,
    dollars_double_time_display:
      r.hours_double_time > HRS_THRESHOLD
        ? formatMoneyCents(r.dollars_double_time)
        : null,
    dollars_premium_other_display:
      r.hours_premium_other > HRS_THRESHOLD
        ? formatMoneyCents(r.dollars_premium_other)
        : null,
    salary_display:
      r.salary_amount > SALARY_THRESHOLD
        ? formatMoneyCents(r.salary_amount)
        : null,
    total_display: formatMoneyCents(r.total_dollars),
    worker_rows: r.worker_rows.map(shapeWorkerDisplay),
  }));

  const period_bands: LaborPeriodBandDisplay[] = m.period_bands.map((b) => ({
    period_no: b.period_no,
    fiscal_year: b.fiscal_year,
    weeks_in_band: b.weeks_in_band,
    hours_regular_display:
      b.hours_regular > HRS_THRESHOLD ? fmtHrs(b.hours_regular) : null,
    hours_overtime_display:
      b.hours_overtime > HRS_THRESHOLD ? fmtHrs(b.hours_overtime) : null,
    hours_double_time_display:
      b.hours_double_time > HRS_THRESHOLD ? fmtHrs(b.hours_double_time) : null,
    hours_premium_other_display:
      b.hours_premium_other > HRS_THRESHOLD
        ? fmtHrs(b.hours_premium_other)
        : null,
    net_dollars_regular_display:
      b.hours_regular > HRS_THRESHOLD
        ? formatMoneyCents(b.net_dollars_regular)
        : null,
    dollars_overtime_display:
      b.hours_overtime > HRS_THRESHOLD
        ? formatMoneyCents(b.dollars_overtime)
        : null,
    dollars_double_time_display:
      b.hours_double_time > HRS_THRESHOLD
        ? formatMoneyCents(b.dollars_double_time)
        : null,
    dollars_premium_other_display:
      b.hours_premium_other > HRS_THRESHOLD
        ? formatMoneyCents(b.dollars_premium_other)
        : null,
    salary_display:
      b.salary_amount > SALARY_THRESHOLD
        ? formatMoneyCents(b.salary_amount)
        : null,
    total_display: formatMoneyCents(b.total_dollars),
    budget_display: formatMoneyWhole(b.budget),
    variance_display: formatMoneyWhole(b.variance_dollars),
    verdict: b.verdict,
  }));

  const grand: LaborGrandDisplay | null = m.grand
    ? {
        hours_display: fmtHrs(m.grand.hours),
        dollars_display: formatMoneyWhole(m.grand.dollars),
        budget_display: formatMoneyWhole(m.grand.budget),
        variance_display: formatMoneyWhole(m.grand.variance_dollars),
        hours_regular_display:
          m.grand.hours_regular > HRS_THRESHOLD
            ? fmtHrs(m.grand.hours_regular)
            : null,
        hours_overtime_display:
          m.grand.hours_overtime > HRS_THRESHOLD
            ? fmtHrs(m.grand.hours_overtime)
            : null,
        hours_double_time_display:
          m.grand.hours_double_time > HRS_THRESHOLD
            ? fmtHrs(m.grand.hours_double_time)
            : null,
        hours_premium_other_display:
          m.grand.hours_premium_other > HRS_THRESHOLD
            ? fmtHrs(m.grand.hours_premium_other)
            : null,
        net_dollars_regular_display:
          m.grand.hours_regular > HRS_THRESHOLD
            ? formatMoneyCents(m.grand.net_dollars_regular)
            : null,
        dollars_overtime_display:
          m.grand.hours_overtime > HRS_THRESHOLD
            ? formatMoneyCents(m.grand.dollars_overtime)
            : null,
        dollars_double_time_display:
          m.grand.hours_double_time > HRS_THRESHOLD
            ? formatMoneyCents(m.grand.dollars_double_time)
            : null,
        dollars_premium_other_display:
          m.grand.hours_premium_other > HRS_THRESHOLD
            ? formatMoneyCents(m.grand.dollars_premium_other)
            : null,
        salary_display:
          m.grand.salary_amount > SALARY_THRESHOLD
            ? formatMoneyCents(m.grand.salary_amount)
            : null,
        total_display: formatMoneyCents(m.grand.total_dollars),
      }
    : null;

  return {
    render: true,
    header_summary_display,
    weeks,
    period_bands,
    grand,
  };
}
