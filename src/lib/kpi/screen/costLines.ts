// src/lib/kpi/screen/costLines.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/CostLines.js (742 lines, closed
// branch only).
//
// The primary cost surface on closed / this-year. Reads:
//   payload.statement_rows        - rows where section === "cogs"
//                                   AND !parent_line_code
//   payload.has_target            - verdict gate
//   payload.cards[cogs]           - total row's target% comes from here
//                                   AND the adjusted_pct_of_revenue
//   payload.period_state === "open" (gates period_cols; NOT in 2d-1)
//   payload.revenue_model
//   payload.statement_totals.revenue.period_budget (scope)
//
// This model is closed-range ONLY. SimpleCostLinesTable (running-
// period variant) is explicitly out of scope and gets implemented
// in train 2d-2.
//
// Per-row v1 compute (CostRow + TotalRow):
//   isBilledBack, isInactive      - flags
//   isCredit                      - actual < 0 (vendor-credit render)
//   adjusted = budget_at_this_revenue
//   actual_pct = row.actual_pct
//   target_pct = row.target_pct
//   varianceVsBatr = actual - adjusted (not budget-to-date; the row
//     column headers Adjusted + Spent are what's compared)
//   variance_pct = actual_pct - target_pct (via row.variance_pct)
//   suppressVerdict = isBilledBack || isInactive || !hasTarget ||
//                     isCredit
//
// Total row sums only "scored" rows (billed-back + inactive excluded
// from actual/adjusted sums). cogsPct comes from the CARD; the
// per-line sum is informational. The over-count pill reads:
//   over_count > 0  -> "N of M over" (bad)
//   rowsWithSpend > 0 -> "all under" (good)
//   else            -> "nothing spent yet" (neutral)
//
// Model fields per row are numbers + state words; the formatter picks
// the display strings.

import {
  formatMoneyWhole,
  formatPct,
  gapDollarsCost,
  gapPointsCost,
} from "./formatting";

export type CostLineFlag =
  | "billed_back"
  | "inactive"
  | "failed"
  | "not_active";

export type CostRowVerdict = "good" | "bad" | "even" | "none";

export type CostLineRow = {
  line_code: string;
  label: string;
  adjusted: number | null;        // budget_at_this_revenue (shown as "Adjusted")
  target_pct: number | null;
  actual: number | null;
  actual_pct: number | null;
  variance_dollars: number | null;    // actual - adjusted
  variance_pct: number | null;        // actual_pct - target_pct
  credit: boolean;                    // actual < 0
  flags: CostLineFlag[];
  verdict: CostRowVerdict;            // tone of the % cell
};

export type CostLinesPillState = "all_under" | "any_over" | "none_spent";

export type CostLinesModel = {
  render: boolean;
  has_target: boolean;
  rows: CostLineRow[];
  total: {
    adjusted: number | null;          // sum(scored.adjusted)
    actual_all: number | null;        // sum(all rows.actual, inc. suppressed)
    actual_scored: number | null;     // sum(scored.actual)
    actual_pct: number | null;        // = cogsCard.pct_of_revenue
    target_pct: number | null;        // = cogsCard.adjusted_pct_of_revenue
    variance_dollars: number | null;  // actual_scored - adjusted
    variance_pct: number | null;      // actual_pct - target_pct
  };
  pill: { state: CostLinesPillState; over_count: number; row_count: number };
};

function pickFlags(raw: any): CostLineFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: CostLineFlag[] = [];
  const allow = new Set(["billed_back", "inactive", "failed", "not_active"]);
  for (const f of raw) if (allow.has(f)) out.push(f as CostLineFlag);
  return out;
}

function isSuppressed(flags: CostLineFlag[]): boolean {
  return flags.includes("billed_back") || flags.includes("inactive");
}

export function buildCostLines(payload: any): CostLinesModel {
  const srAll = Array.isArray(payload?.statement_rows)
    ? payload.statement_rows
    : null;
  if (!srAll) {
    return {
      render: false,
      has_target: false,
      rows: [],
      total: {
        adjusted: null,
        actual_all: null,
        actual_scored: null,
        actual_pct: null,
        target_pct: null,
        variance_dollars: null,
        variance_pct: null,
      },
      pill: { state: "none_spent", over_count: 0, row_count: 0 },
    };
  }
  const hasTarget = !!payload?.has_target;

  const cogsRows: any[] = srAll
    .filter((r: any) => r && r.section === "cogs" && !r.parent_line_code)
    .sort((a: any, b: any) => Number(a.line_code) - Number(b.line_code));
  if (cogsRows.length === 0) {
    return {
      render: false,
      has_target: hasTarget,
      rows: [],
      total: {
        adjusted: null,
        actual_all: null,
        actual_scored: null,
        actual_pct: null,
        target_pct: null,
        variance_dollars: null,
        variance_pct: null,
      },
      pill: { state: "none_spent", over_count: 0, row_count: 0 },
    };
  }

  const cogsCard = Array.isArray(payload?.cards)
    ? payload.cards.find((c: any) => c?.key === "cogs")
    : null;
  const totalActualPct =
    cogsCard?.pct_of_revenue != null ? Number(cogsCard.pct_of_revenue) : null;
  const totalTargetPct =
    cogsCard?.adjusted_pct_of_revenue != null
      ? Number(cogsCard.adjusted_pct_of_revenue)
      : null;

  let sumActualAll = 0;
  let anyActualAll = false;
  let sumActualScored = 0;
  let anyActualScored = false;
  let sumAdjusted = 0;
  let anyAdjusted = false;
  let overCount = 0;
  let rowsWithSpend = 0;

  const rows: CostLineRow[] = cogsRows.map((r: any) => {
    const flags = pickFlags(r.flags);
    const adjusted =
      r.budget_at_this_revenue != null
        ? Number(r.budget_at_this_revenue)
        : null;
    const actual = r.actual != null ? Number(r.actual) : null;
    const actualPct = r.actual_pct != null ? Number(r.actual_pct) : null;
    const targetPct = r.target_pct != null ? Number(r.target_pct) : null;
    const varDollars =
      actual != null && adjusted != null ? actual - adjusted : null;
    const varPct =
      r.variance_pct != null
        ? Number(r.variance_pct)
        : actualPct != null && targetPct != null
          ? actualPct - targetPct
          : null;
    const credit = actual != null && actual < 0;
    const suppress = isSuppressed(flags) || !hasTarget || credit;

    let verdict: CostRowVerdict = "none";
    if (!suppress && varDollars != null) {
      if (Math.abs(varDollars) < 1) verdict = "even";
      else verdict = varDollars > 0 ? "bad" : "good";
    }

    if (actual != null) {
      sumActualAll += actual;
      anyActualAll = true;
    }
    if (!isSuppressed(flags)) {
      if (actual != null) {
        sumActualScored += actual;
        anyActualScored = true;
        if (actual > 0.5) rowsWithSpend += 1;
      }
      if (adjusted != null) {
        sumAdjusted += adjusted;
        anyAdjusted = true;
      }
      if (
        actual != null &&
        adjusted != null &&
        actual - adjusted > 0
      ) {
        overCount += 1;
      }
    }

    return {
      line_code: String(r.line_code),
      label: String(r.label ?? ""),
      adjusted,
      target_pct: targetPct,
      actual,
      actual_pct: actualPct,
      variance_dollars: varDollars,
      variance_pct: varPct,
      credit,
      flags,
      verdict,
    };
  });

  const totalAdjusted = anyAdjusted ? sumAdjusted : null;
  const totalActualAll = anyActualAll ? sumActualAll : null;
  const totalActualScored = anyActualScored ? sumActualScored : null;
  const totalVarDollars =
    totalAdjusted != null && totalActualScored != null
      ? totalActualScored - totalAdjusted
      : null;
  const totalVarPct =
    totalActualPct != null && totalTargetPct != null
      ? totalActualPct - totalTargetPct
      : null;

  let pillState: CostLinesPillState;
  if (overCount > 0) pillState = "any_over";
  else if (rowsWithSpend > 0) pillState = "all_under";
  else pillState = "none_spent";

  return {
    render: true,
    has_target: hasTarget,
    rows,
    total: {
      adjusted: totalAdjusted,
      actual_all: totalActualAll,
      actual_scored: totalActualScored,
      actual_pct: totalActualPct,
      target_pct: totalTargetPct,
      variance_dollars: totalVarDollars,
      variance_pct: totalVarPct,
    },
    pill: { state: pillState, over_count: overCount, row_count: cogsRows.length },
  };
}

// --- Formatter ----------------------------------------------------

export type CostLineRowDisplay = {
  line_code: string;
  label: string;
  adjusted_display: string | null;    // or "billed back" / "not active"
  target_pct_display: string | null;
  actual_display: string | null;      // "$X" or "$X credit" or "—"
  actual_pct_display: string | null;
  variance_dollars_display: string | null;  // "$X under"/"$X over"/"on budget"
  variance_pct_display: string | null;
  verdict: CostRowVerdict;
  flags: CostLineFlag[];
  credit: boolean;
};

export type CostLinesDisplay = {
  render: boolean;
  has_target: boolean;
  rows: CostLineRowDisplay[];
  total: {
    adjusted_display: string | null;
    actual_display: string | null;
    actual_pct_display: string | null;
    target_pct_display: string | null;
    variance_dollars_display: string | null;
    variance_pct_display: string | null;
  };
  pill_text: string;
  pill_tone: "good" | "bad" | "neutral";
  over_count: number;
  row_count: number;
};

function formatCostActual(c: CostLineRow): string | null {
  if (c.actual == null) return null;
  if (c.credit) {
    const abs = Math.abs(Math.round(c.actual));
    return `$${abs.toLocaleString("en-US")} credit`;
  }
  return formatMoneyWhole(c.actual);
}

function formatRow(c: CostLineRow): CostLineRowDisplay {
  const flagsSet = new Set(c.flags);
  let adjustedDisplay: string | null = null;
  if (flagsSet.has("billed_back")) adjustedDisplay = "billed back";
  else if (flagsSet.has("inactive")) adjustedDisplay = "not active";
  else adjustedDisplay = formatMoneyWhole(c.adjusted);

  const suppress =
    flagsSet.has("billed_back") || flagsSet.has("inactive") || c.credit;
  const targetPctDisplay = suppress ? null : formatPct(c.target_pct);
  const actualPctDisplay = suppress ? null : formatPct(c.actual_pct);
  const varDollarsDisplay =
    suppress || c.variance_dollars == null
      ? null
      : gapDollarsCost(c.variance_dollars);
  const varPctDisplay =
    suppress || c.variance_pct == null ? null : gapPointsCost(c.variance_pct);

  return {
    line_code: c.line_code,
    label: c.label,
    adjusted_display: adjustedDisplay,
    target_pct_display: targetPctDisplay,
    actual_display: formatCostActual(c),
    actual_pct_display: actualPctDisplay,
    variance_dollars_display: varDollarsDisplay,
    variance_pct_display: varPctDisplay,
    verdict: c.verdict,
    flags: c.flags,
    credit: c.credit,
  };
}

export function formatCostLines(m: CostLinesModel): CostLinesDisplay {
  if (!m.render) {
    return {
      render: false,
      has_target: m.has_target,
      rows: [],
      total: {
        adjusted_display: null,
        actual_display: null,
        actual_pct_display: null,
        target_pct_display: null,
        variance_dollars_display: null,
        variance_pct_display: null,
      },
      pill_text: "nothing spent yet",
      pill_tone: "neutral",
      over_count: 0,
      row_count: 0,
    };
  }
  let pillText: string;
  let pillTone: "good" | "bad" | "neutral";
  if (m.pill.state === "any_over") {
    pillText = `${m.pill.over_count} of ${m.pill.row_count} over`;
    pillTone = "bad";
  } else if (m.pill.state === "all_under") {
    pillText = "all under";
    pillTone = "good";
  } else {
    pillText = "nothing spent yet";
    pillTone = "neutral";
  }
  return {
    render: true,
    has_target: m.has_target,
    rows: m.rows.map(formatRow),
    total: {
      adjusted_display: m.has_target
        ? formatMoneyWhole(m.total.adjusted)
        : null,
      actual_display: formatMoneyWhole(m.total.actual_all),
      actual_pct_display: formatPct(m.total.actual_pct),
      target_pct_display: m.has_target ? formatPct(m.total.target_pct) : null,
      variance_dollars_display: m.has_target
        ? m.total.variance_dollars != null
          ? gapDollarsCost(m.total.variance_dollars)
          : null
        : null,
      variance_pct_display: m.has_target
        ? m.total.variance_pct != null
          ? gapPointsCost(m.total.variance_pct)
          : null
        : null,
    },
    pill_text: pillText,
    pill_tone: pillTone,
    over_count: m.pill.over_count,
    row_count: m.pill.row_count,
  };
}
