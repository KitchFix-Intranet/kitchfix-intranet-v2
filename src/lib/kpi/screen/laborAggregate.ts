// src/lib/kpi/screen/laborAggregate.ts
//
// Train 2d-1. MOVE WHOLE from v1:
//   src/app/kpi/labor/lib/aggregate.js (422 lines).
//
// v1 uses v1's labor/lib/periods.js (no fy argument). V2's periods
// take an explicit `fy`. The move adds `fy` as the last argument to
// every function that depends on period arithmetic, mirroring the
// train-2b convention. All business logic is byte-identical except
// for that signature change. Twin tests at __tests__/laborAggregate
// .test.mjs run v1's own function at the pin against this one on
// hand-built actuals.

import type { FiscalYear } from "@/lib/kpi/shared/fiscalYear";
import {
  periodOf,
  fiscalYearOf,
  currentPeriodNo,
  r93FytdEndISO,
} from "@/lib/kpi/labor/periods";

// Helper mirroring v1's periodsInBoardWeeks (signalCardModels.js).
export function periodsInBoardWeeks(board: any): any[] {
  const byPeriod = new Map<number, any>();
  for (const w of board?.weeks || []) {
    if (w.period_no == null) continue;
    let cur = byPeriod.get(w.period_no);
    if (!cur) {
      cur = {
        period_no: w.period_no,
        fiscal_year: w.fiscal_year ?? 2026,
        weeks_in_period: 0,
      };
      byPeriod.set(w.period_no, cur);
    }
    cur.weeks_in_period += 1;
  }
  return [...byPeriod.values()].sort((a, b) => a.period_no - b.period_no);
}

// Verbatim from v1 labor/page.js:58-65 via aggregate.js.
export function workerLabel(meta: any, worker_id: any, redact: any): string {
  const num =
    meta?.number != null ? `#${meta.number}` : `#${String(worker_id).slice(0, 6)}`;
  if (redact || !meta?.display_name) {
    const title = meta?.title ? ` · ${meta.title}` : "";
    return `${num}${title}`;
  }
  return `${meta.display_name} (${num})`;
}

export function buildFilteredActuals(
  actuals: any,
  selectedWorkers: Set<string> | null | undefined,
): any[] {
  if (!actuals) return [];
  if (!selectedWorkers || selectedWorkers.size === 0) return actuals;
  return actuals.filter((r: any) => selectedWorkers.has(r.worker_id));
}

export function buildWeekAggregates(
  filteredActuals: any,
  aggregateExcludedSet: Set<string>,
  boardWeeks: any,
  fy: FiscalYear,
): any[] {
  const excludedFromRollup = (r: any) =>
    aggregateExcludedSet.has(r.account_key);
  if (!filteredActuals?.length) return [];
  const byWeek = new Map<string, any>();
  for (const r of filteredActuals) {
    const wk = r.week_start;
    if (!byWeek.has(wk)) {
      byWeek.set(wk, {
        week_start: r.week_start,
        week_end: r.week_end,
        week_label: r.week_label,
        fiscal_year: fiscalYearOf(r.week_start, fy) ?? r.fiscal_year ?? fy.year,
        period_no: periodOf(r.week_start, fy),
        hours_regular: 0,
        hours_overtime: 0,
        hours_double_time: 0,
        hours_premium_other: 0,
        dollars_regular: 0,
        dollars_overtime: 0,
        dollars_double_time: 0,
        dollars_premium_other: 0,
        amount: 0,
        hours_without_dollars: 0,
        draft_entry_count: 0,
        draft_hours: 0,
        anomaly_no_clockout: 0,
        anomaly_under_1h: 0,
        anomaly_over_16h: 0,
        worker_rows: [] as any[],
        coverage_states: new Set<string>(),
      });
    }
    const w = byWeek.get(wk);
    w.worker_rows.push(r);
    w.coverage_states.add(r.coverage_state);
    if (excludedFromRollup(r)) continue;
    w.hours_regular += Number(r.hours_regular || 0);
    w.hours_overtime += Number(r.hours_overtime || 0);
    w.hours_double_time += Number(r.hours_double_time || 0);
    w.hours_premium_other += Number(r.hours_premium_other || 0);
    w.dollars_regular += Number(r.dollars_regular || 0);
    w.dollars_overtime += Number(r.dollars_overtime || 0);
    w.dollars_double_time += Number(r.dollars_double_time || 0);
    w.dollars_premium_other += Number(r.dollars_premium_other || 0);
    w.amount += Number(r.amount || 0);
    w.hours_without_dollars += Number(r.hours_without_dollars || 0);
    w.draft_entry_count += Number(r.draft_entry_count || 0);
    w.draft_hours += Number(r.draft_hours || 0);
    w.anomaly_no_clockout += Number(r.anomaly_no_clockout || 0);
    w.anomaly_under_1h += Number(r.anomaly_under_1h || 0);
    w.anomaly_over_16h += Number(r.anomaly_over_16h || 0);
  }
  for (const w of byWeek.values()) {
    const states = [...w.coverage_states];
    w.coverage_state = states.length === 1 ? states[0] : "partial";
    if (
      (w.coverage_state === "unknown" || w.coverage_state === "hours_only") &&
      w.amount > 0.01
    ) {
      w.coverage_state = "partial";
    }
  }
  const boardWeeksByStart = new Map(
    (boardWeeks || []).map((bw: any) => [bw.week_start, bw]),
  );
  for (const w of byWeek.values()) {
    const bw = boardWeeksByStart.get(w.week_start) as any;
    if (bw && bw.budget_at_this_week_revenue != null) {
      w.budget_at_this_week_revenue = Number(bw.budget_at_this_week_revenue);
    }
  }
  return [...byWeek.values()].sort((a, b) =>
    b.week_start.localeCompare(a.week_start),
  );
}

export function buildGrouped(
  weekAggregates: any[],
  rangeSelectionEarly: any,
  board: any,
  fy: FiscalYear,
): any[] {
  const groupByMonth = rangeSelectionEarly?.kind === "month";
  const MONTH_NAMES = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
  ];
  const groups: any[] = [];
  for (const w of weekAggregates) {
    const fyy = w.fiscal_year ?? fy.year;
    let key: string, sortKey: number, groupLabel: any, groupHint: any;
    if (groupByMonth) {
      const [yy, mm] = w.week_start.split("-").map(Number);
      const year = yy;
      const monthIndex = mm - 1;
      key = `M-${year}-${monthIndex}`;
      sortKey = year * 100 + monthIndex;
      groupLabel = `${MONTH_NAMES[monthIndex]} ${year}`;
      groupHint = { kind: "month", year, monthIndex };
    } else {
      const p = w.period_no ?? 0;
      key = `P-${fyy}|${p}`;
      sortKey = -(fyy * 100 + p);
      groupHint = { kind: "period", period_no: p, fiscal_year: fyy };
    }
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = {
        key,
        fiscal_year: fyy,
        period_no: w.period_no ?? 0,
        weeks: [] as any[],
        subtotal: null as any,
        groupLabel,
        groupHint,
        sortKey,
      };
      groups.push(g);
    }
    g.weeks.push(w);
  }
  if (groupByMonth) {
    groups.sort((a, b) => a.sortKey - b.sortKey);
  } else {
    groups.sort((a, b) => a.sortKey - b.sortKey);
  }
  if (groupByMonth) {
    for (const g of groups) {
      g.groupLabel = `${g.groupLabel} · ${g.weeks.length} fiscal wk${
        g.weeks.length === 1 ? "" : "s"
      }`;
    }
  }
  for (const g of groups) {
    const s = {
      hours_regular: 0,
      hours_overtime: 0,
      hours_double_time: 0,
      hours_premium_other: 0,
      dollars_regular: 0,
      dollars_overtime: 0,
      dollars_double_time: 0,
      dollars_premium_other: 0,
      amount: 0,
      hours_without_dollars: 0,
      draft_hours: 0,
    };
    for (const w of g.weeks) {
      s.hours_regular += w.hours_regular;
      s.hours_overtime += w.hours_overtime;
      s.hours_double_time += w.hours_double_time;
      s.hours_premium_other += w.hours_premium_other;
      s.dollars_regular += w.dollars_regular || 0;
      s.dollars_overtime += w.dollars_overtime || 0;
      s.dollars_double_time += w.dollars_double_time || 0;
      s.dollars_premium_other += w.dollars_premium_other || 0;
      s.amount += w.amount;
      s.hours_without_dollars += w.hours_without_dollars;
      s.draft_hours += w.draft_hours || 0;
    }
    g.subtotal = s;
  }
  if (!groupByMonth && board) {
    const canonicalPeriods = periodsInBoardWeeks(board);
    const canonicalByPeriod = new Map(
      canonicalPeriods.map((p: any) => [p.period_no, p]),
    );
    const boardWeeksByPeriod = new Map<number, any[]>();
    for (const bw of board?.weeks || []) {
      const p = periodOf(bw.week_start, fy);
      if (p == null) continue;
      if (!boardWeeksByPeriod.has(p)) boardWeeksByPeriod.set(p, []);
      boardWeeksByPeriod.get(p)!.push(bw);
    }
    for (const g of groups) {
      if (g.groupHint?.kind !== "period") continue;
      const canonical = canonicalByPeriod.get(g.period_no) as any;
      g.weeks_in_period = canonical
        ? canonical.weeks_in_period
        : g.weeks.length;
      const periodBoardWeeks = boardWeeksByPeriod.get(g.period_no) || [];
      let batrSum = 0;
      let batrAny = false;
      for (const bw of periodBoardWeeks) {
        if (bw.state === "not_started") continue;
        if (bw.budget_at_this_week_revenue != null) {
          batrSum += Number(bw.budget_at_this_week_revenue);
          batrAny = true;
        }
      }
      g.period_budget_total = batrAny ? Math.round(batrSum * 100) / 100 : null;
    }
    const seenPeriods = new Set(
      groups
        .filter((g) => g.groupHint?.kind === "period")
        .map((g) => g.period_no),
    );
    for (const p of canonicalPeriods) {
      if (seenPeriods.has(p.period_no)) continue;
      const key = `P-${p.fiscal_year}|${p.period_no}`;
      groups.push({
        key,
        fiscal_year: p.fiscal_year,
        period_no: p.period_no,
        weeks: [],
        subtotal: {
          hours_regular: 0,
          hours_overtime: 0,
          hours_double_time: 0,
          hours_premium_other: 0,
          amount: 0,
          hours_without_dollars: 0,
          draft_hours: 0,
        },
        groupLabel: undefined,
        groupHint: {
          kind: "period",
          period_no: p.period_no,
          fiscal_year: p.fiscal_year,
        },
        sortKey: -(p.fiscal_year * 100 + p.period_no),
        zero_labor: true,
        weeks_in_period: p.weeks_in_period,
      });
    }
    groups.sort((a, b) => a.sortKey - b.sortKey);
  }
  return groups;
}

export function buildWorkerRoster(
  actuals: any,
  workers: any,
  redact: any,
): any[] {
  if (!actuals) return [];
  const ids = [...new Set(actuals.map((r: any) => r.worker_id))];
  return ids
    .map((id: any) => ({
      id,
      label: workerLabel(workers?.[id], id, redact),
      meta: workers?.[id],
    }))
    .sort((a: any, b: any) => a.label.localeCompare(b.label));
}

export function buildGrand(
  grouped: any[],
  today: any,
  avgRate: any,
  fy: FiscalYear,
): any {
  if (!grouped.length) return null;
  const rate = avgRate ?? null;
  const g: any = {
    hours_regular: 0,
    hours_overtime: 0,
    hours_double_time: 0,
    hours_premium_other: 0,
    dollars_regular: 0,
    dollars_overtime: 0,
    dollars_double_time: 0,
    dollars_premium_other: 0,
    amount: 0,
    hours_without_dollars: 0,
    draft_hours: 0,
    hatched: 0,
  };
  const currentP = currentPeriodNo(today, fy);
  for (const period of grouped) {
    const isRunning =
      period.groupHint?.kind === "period" &&
      period.period_no === currentP &&
      grouped.length > 1;
    if (isRunning) continue;
    g.hours_regular += period.subtotal.hours_regular;
    g.hours_overtime += period.subtotal.hours_overtime;
    g.hours_double_time += period.subtotal.hours_double_time;
    g.hours_premium_other += period.subtotal.hours_premium_other || 0;
    g.dollars_regular += period.subtotal.dollars_regular || 0;
    g.dollars_overtime += period.subtotal.dollars_overtime || 0;
    g.dollars_double_time += period.subtotal.dollars_double_time || 0;
    g.dollars_premium_other += period.subtotal.dollars_premium_other || 0;
    g.amount += period.subtotal.amount;
    g.hours_without_dollars += period.subtotal.hours_without_dollars;
    g.draft_hours += period.subtotal.draft_hours || 0;
    for (const w of period.weeks || []) {
      const uphrs = Number(w.hours_without_dollars || 0);
      const draftHrs = Number(w.draft_hours || 0);
      const amt = Number(w.amount || 0);
      if (rate) {
        if (uphrs > 0.004) g.hatched += uphrs * Number(rate);
        if (draftHrs > 0.004 && amt > 0.5) g.hatched += draftHrs * Number(rate);
      }
    }
  }
  return g;
}

export function buildWorkerRangeTotals(filteredActuals: any): any {
  const m: Record<string, { hoursWorked: number; dollarsTotal: number }> = {};
  for (const r of filteredActuals) {
    const id = r.worker_id;
    if (!m[id]) m[id] = { hoursWorked: 0, dollarsTotal: 0 };
    m[id].hoursWorked +=
      Number(r.hours_regular || 0) +
      Number(r.hours_overtime || 0) +
      Number(r.hours_double_time || 0);
    m[id].dollarsTotal += Number(r.amount || 0);
  }
  return m;
}

export function computeResolvedPreset(
  lastPreset: any,
  start: any,
  end: any,
  today: any,
  accountPeriods: any,
  fy: FiscalYear,
  fyStartISO: string,
): any {
  if (lastPreset) return lastPreset;
  const fytdEnd = r93FytdEndISO(today, fy);
  if (start === fyStartISO && fytdEnd && end === fytdEnd) return "fytd";
  const periods = accountPeriods || [];
  if (periods.length) {
    const past = periods
      .filter((p: any) => p.start && p.end && p.start <= today)
      .sort((a: any, b: any) => a.start.localeCompare(b.start));
    const cur = past[past.length - 1];
    const prev = past[past.length - 2];
    if (cur && start === cur.start && end === cur.end) return "this_period";
    if (prev && start === prev.start && end === prev.end) return "last_period";
  }
  return null;
}
