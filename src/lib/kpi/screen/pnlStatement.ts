// src/lib/kpi/screen/pnlStatement.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/PnlStatement.js (680 lines).
//
// The full P&L fold. Reads:
//   payload.statement_rows      - lines + parented sub-lines
//   payload.statement_totals    - revenue / cogs / gross_margin totals
//   payload.cards               - revenue / cogs / gm cards
//   payload.also_tracked        - rendered as a third band in Full view
//   payload.filters.include_salary - gates Full / Summary toggle
//
// This model is CLOSED-range only. The running-period branches
// inside v1 (isRunning gates) are dropped; they land in 2d-2.
//
// Two shapes: summary (collapsed) + full (expanded). v1 enforces
// "every figure the two share must agree."
//
// Each row carries:
//   line_code, label, variant: "line" | "sub" | "tracked" | "total"
//   budget (budget_to_date), target_pct, adjusted (batr), actual,
//   actual_pct, variance_dollars (vs ref), ref_field: "budget"|"adjusted"
//   axis: "rev" | "cost" | "margin"
//   indent_level: 0 for lines/totals; 1 for subs
//   hatches: { target_pct: boolean, adjusted: boolean } - v1's na-cell
//   inactive: boolean (whole row gets "not active")
//   reported: boolean
//
// Verdict tone per row follows the gap sign on the chosen axis.

import {
  formatMoneyWhole,
  formatPct,
  signedMagnitudeMoney,
} from "./formatting";

export type PnlAxis = "rev" | "cost" | "margin";
export type PnlVariant = "line" | "sub" | "section" | "total" | "tracked";

export type PnlRow = {
  variant: PnlVariant;
  line_code: string | null;
  label: string;
  section: "revenue" | "cogs" | "margin" | "tracked" | null;
  axis: PnlAxis | null;
  budget: number | null;                // budget_to_date
  target_pct: number | null;
  adjusted: number | null;              // budget_at_this_revenue
  actual: number | null;
  actual_pct: number | null;
  variance_dollars: number | null;      // actual - ref (per ref_field)
  ref_field: "budget" | "adjusted" | null;
  hatch_target_pct: boolean;
  hatch_adjusted: boolean;
  hatch_actual: boolean;
  hatch_actual_pct: boolean;
  hatch_variance: boolean;
  indent: number;
  inactive: boolean;
  reported: boolean;
  credit: boolean;
  verdict: "good" | "bad" | "even" | "none";
};

export type PnlStatementModel = {
  render: boolean;
  include_salary: boolean;              // gates the Full/Summary toggle
  summary_rows: PnlRow[];
  full_rows: PnlRow[];
};

function rowVerdict(
  axis: PnlAxis | null,
  variance_dollars: number | null,
  inactive: boolean,
  reported: boolean,
): "good" | "bad" | "even" | "none" {
  if (inactive || !reported) return "none";
  if (variance_dollars == null || !Number.isFinite(variance_dollars))
    return "none";
  if (Math.abs(variance_dollars) < 1) return "even";
  const up = variance_dollars > 0;
  if (axis === "rev" || axis === "margin") return up ? "good" : "bad";
  if (axis === "cost") return up ? "bad" : "good";
  return "none";
}

function hasFlag(row: any, name: string): boolean {
  return Array.isArray(row?.flags) && row.flags.includes(name);
}

function buildLineRow(
  raw: any,
  opts: {
    variant: PnlVariant;
    axis: PnlAxis;
    section: "revenue" | "cogs" | "margin" | "tracked";
    hatch_target_pct?: boolean;
    hatch_adjusted?: boolean;
    ref_field: "budget" | "adjusted";
    indent: number;
    totalRevenue?: number | null;
  },
): PnlRow {
  const inactive = hasFlag(raw, "inactive");
  const budget = raw?.budget_to_date != null ? Number(raw.budget_to_date) : null;
  const targetPct =
    raw?.target_pct != null ? Number(raw.target_pct) : null;
  const adjusted =
    raw?.budget_at_this_revenue != null
      ? Number(raw.budget_at_this_revenue)
      : null;
  const actual = raw?.actual != null ? Number(raw.actual) : null;
  const reported = raw?.reported !== false;
  const credit = opts.axis === "cost" && actual != null && actual < 0;
  const actualPct =
    raw?.actual_pct != null
      ? Number(raw.actual_pct)
      : reported && actual != null && opts.totalRevenue != null && opts.totalRevenue > 0
        ? (actual / opts.totalRevenue) * 100
        : null;
  const ref = opts.ref_field === "adjusted" ? adjusted : budget;
  const variance_dollars =
    actual != null && ref != null ? actual - ref : null;
  return {
    variant: opts.variant,
    line_code: raw?.line_code != null ? String(raw.line_code) : null,
    label: String(raw?.label ?? ""),
    section: opts.section,
    axis: opts.axis,
    budget,
    target_pct: targetPct,
    adjusted,
    actual,
    actual_pct: actualPct,
    variance_dollars,
    ref_field: opts.ref_field,
    hatch_target_pct: !!opts.hatch_target_pct,
    hatch_adjusted: !!opts.hatch_adjusted,
    hatch_actual: false,
    hatch_actual_pct: credit,     // "— %" on credit rows
    hatch_variance: false,
    indent: opts.indent,
    inactive,
    reported,
    credit,
    verdict: rowVerdict(
      opts.axis,
      variance_dollars,
      inactive,
      reported && !credit,
    ),
  };
}

function totalRow(
  label: string,
  section: "revenue" | "cogs" | "margin",
  axis: PnlAxis,
  tot: any,
  opts: {
    adjusted?: number | null;  // GM uses margin_at_this_revenue
    ref_field: "budget" | "adjusted";
  },
): PnlRow {
  const budget = tot?.budget_to_date != null ? Number(tot.budget_to_date) : null;
  const targetPct =
    tot?.target_pct != null ? Number(tot.target_pct) : null;
  const adjustedRaw =
    opts.adjusted != null
      ? opts.adjusted
      : tot?.budget_at_this_revenue != null
        ? Number(tot.budget_at_this_revenue)
        : null;
  const actual = tot?.actual != null ? Number(tot.actual) : null;
  const actualPct =
    section === "revenue"
      ? actual != null
        ? 100
        : null
      : tot?.actual_pct != null
        ? Number(tot.actual_pct)
        : null;
  const ref = opts.ref_field === "adjusted" ? adjustedRaw : budget;
  const variance_dollars =
    actual != null && ref != null ? actual - ref : null;
  return {
    variant: "total",
    line_code: null,
    label,
    section,
    axis,
    budget,
    target_pct: targetPct,
    adjusted: adjustedRaw,
    actual,
    actual_pct: actualPct,
    variance_dollars,
    ref_field: opts.ref_field,
    hatch_target_pct: false,
    hatch_adjusted: section === "revenue",   // revenue total hatches Adjusted on closed
    hatch_actual: false,
    hatch_actual_pct: false,
    hatch_variance: false,
    indent: 0,
    inactive: false,
    reported: actual != null,
    credit: false,
    verdict: rowVerdict(axis, variance_dollars, false, actual != null),
  };
}

function sectionRow(label: string): PnlRow {
  return {
    variant: "section",
    line_code: null,
    label,
    section: null,
    axis: null,
    budget: null,
    target_pct: null,
    adjusted: null,
    actual: null,
    actual_pct: null,
    variance_dollars: null,
    ref_field: null,
    hatch_target_pct: false,
    hatch_adjusted: false,
    hatch_actual: false,
    hatch_actual_pct: false,
    hatch_variance: false,
    indent: 0,
    inactive: false,
    reported: true,
    credit: false,
    verdict: "none",
  };
}

export function buildPnlStatement(payload: any): PnlStatementModel {
  const rows = Array.isArray(payload?.statement_rows)
    ? payload.statement_rows
    : null;
  if (!rows) {
    return {
      render: false,
      include_salary: false,
      summary_rows: [],
      full_rows: [],
    };
  }
  const includeSalary = !!payload?.filters?.include_salary;

  const revenueAll = rows.filter(
    (r: any) => r?.section === "revenue" && !r.parent_line_code,
  );
  const cogsAll = rows.filter(
    (r: any) => r?.section === "cogs" && !r.parent_line_code,
  );
  const subs = rows.filter(
    (r: any) => r?.section === "cogs" && r.parent_line_code,
  );
  const subsByParent = new Map<string, any[]>();
  for (const s of subs) {
    const k = String(s.parent_line_code);
    if (!subsByParent.has(k)) subsByParent.set(k, []);
    subsByParent.get(k)!.push(s);
  }
  const tracked = Array.isArray(payload?.also_tracked)
    ? payload.also_tracked
    : [];
  const totals = payload?.statement_totals ?? {};
  const revenueCard = Array.isArray(payload?.cards)
    ? payload.cards.find((c: any) => c?.key === "revenue")
    : null;
  const totalRevenue =
    revenueCard?.hero_actual != null ? Number(revenueCard.hero_actual) : null;

  // Shared row-builders.
  const revRow = (r: any) =>
    buildLineRow(r, {
      variant: "line",
      axis: "rev",
      section: "revenue",
      hatch_adjusted: true,
      ref_field: "budget",
      indent: 0,
      totalRevenue,
    });
  const cogsParentRow = (r: any) =>
    buildLineRow(r, {
      variant: "line",
      axis: "cost",
      section: "cogs",
      ref_field: "adjusted",
      indent: 0,
      totalRevenue,
    });
  const cogsSubRow = (r: any) => {
    const isSalary = hasFlag(r, "not_applicable_target_pct");
    // Kevin CC prompt 2026-09-11 (R-99 superseded).  Salary sub-rows
    // NO LONGER hatch target_pct + adjusted - the P&L now publishes
    // target_pct on 3100.2 as `budget / budgeted revenue` and renders
    // Adjusted as a real value.  The isSalary flag still gates
    // ref_field (variance basis = budget, not adjusted) but hatch
    // rules are off.  2026-11-20 strict-compare fix: align V2 with
    // the shipped v1 behaviour so the pnl row figures match the DOM.
    return buildLineRow(r, {
      variant: "sub",
      axis: "cost",
      section: "cogs",
      ref_field: isSalary ? "budget" : "adjusted",
      hatch_target_pct: false,
      hatch_adjusted: false,
      indent: 1,
      totalRevenue,
    });
  };
  const trackedRow = (t: any) => {
    const shim = {
      line_code: t.line_code,
      label: t.label,
      budget_to_date: t.budget,
      budget_at_this_revenue: null,
      actual: t.actual,
      actual_pct:
        t.actual != null && totalRevenue != null && totalRevenue > 0
          ? (Number(t.actual) / totalRevenue) * 100
          : null,
      target_pct: null,
      reported: t.actual != null,
      flags: [],
    };
    return buildLineRow(shim, {
      variant: "tracked",
      axis: "cost",
      section: "tracked",
      hatch_target_pct: true,
      hatch_adjusted: true,
      ref_field: "budget",
      indent: 0,
      totalRevenue,
    });
  };

  const revenueRowsFull = revenueAll.map(revRow);
  const revenueRowsSummary = revenueAll
    .filter((r: any) => !hasFlag(r, "inactive"))
    .map(revRow);

  const cogsRowsFull: PnlRow[] = [];
  const cogsRowsSummary: PnlRow[] = [];
  for (const parent of cogsAll) {
    const parentRow = cogsParentRow(parent);
    if (!hasFlag(parent, "inactive")) cogsRowsSummary.push(parentRow);
    cogsRowsFull.push(parentRow);
    const children = subsByParent.get(String(parent.line_code)) || [];
    for (const s of children) cogsRowsFull.push(cogsSubRow(s));
  }

  const revTotal = totalRow("Total revenue", "revenue", "rev", totals.revenue, {
    ref_field: "budget",
  });
  const cogsTotal = totalRow(
    "Total cost of goods sold",
    "cogs",
    "cost",
    totals.cogs,
    { ref_field: "adjusted" },
  );
  const gmAdjusted =
    totals.gross_margin?.margin_at_this_revenue != null
      ? Number(totals.gross_margin.margin_at_this_revenue)
      : null;
  const gmTotal = totalRow(
    "Gross margin",
    "margin",
    "margin",
    totals.gross_margin,
    { adjusted: gmAdjusted, ref_field: "adjusted" },
  );

  const summary_rows: PnlRow[] = [
    sectionRow("Revenue"),
    ...revenueRowsSummary,
    revTotal,
    sectionRow("Cost of goods sold"),
    ...cogsRowsSummary,
    cogsTotal,
    gmTotal,
  ];
  const full_rows: PnlRow[] = [
    sectionRow("Revenue"),
    ...revenueRowsFull,
    revTotal,
    sectionRow("Cost of goods sold"),
    ...cogsRowsFull,
    cogsTotal,
    gmTotal,
  ];
  if (tracked.length > 0) {
    full_rows.push(sectionRow("Also tracked · outside gross margin"));
    for (const t of tracked) full_rows.push(trackedRow(t));
  }
  return {
    render: true,
    include_salary: includeSalary,
    summary_rows,
    full_rows,
  };
}

// --- Formatter ----------------------------------------------------

export type PnlRowDisplay = {
  variant: PnlVariant;
  line_code: string | null;
  label: string;
  indent: number;
  budget_display: string | null;
  target_pct_display: string | null;
  adjusted_display: string | null;
  actual_display: string | null;
  actual_pct_display: string | null;
  variance_display: string | null;          // "on budget" | "$X" with arrow
  variance_arrow: "↑" | "↓" | null;
  verdict: "good" | "bad" | "even" | "none";
  hatch_target_pct: boolean;
  hatch_adjusted: boolean;
  hatch_actual: boolean;
  hatch_actual_pct: boolean;
  hatch_variance: boolean;
  inactive: boolean;
  not_reported: boolean;
  credit: boolean;
};

export type PnlStatementDisplay = {
  render: boolean;
  include_salary: boolean;
  summary_rows: PnlRowDisplay[];
  full_rows: PnlRowDisplay[];
};

function fmtActualForRow(r: PnlRow): string | null {
  if (r.actual == null) return null;
  if (r.credit) {
    const abs = Math.abs(Math.round(r.actual));
    return `$${abs.toLocaleString("en-US")} credit`;
  }
  return formatMoneyWhole(r.actual);
}

function formatRow(r: PnlRow): PnlRowDisplay {
  if (r.variant === "section") {
    return {
      variant: "section",
      line_code: null,
      label: r.label,
      indent: 0,
      budget_display: null,
      target_pct_display: null,
      adjusted_display: null,
      actual_display: null,
      actual_pct_display: null,
      variance_display: null,
      variance_arrow: null,
      verdict: "none",
      hatch_target_pct: false,
      hatch_adjusted: false,
      hatch_actual: false,
      hatch_actual_pct: false,
      hatch_variance: false,
      inactive: false,
      not_reported: false,
      credit: false,
    };
  }
  if (r.inactive) {
    return {
      variant: r.variant,
      line_code: r.line_code,
      label: r.label,
      indent: r.indent,
      budget_display: null,
      target_pct_display: null,
      adjusted_display: null,
      actual_display: null,
      actual_pct_display: null,
      variance_display: null,
      variance_arrow: null,
      verdict: "none",
      hatch_target_pct: false,
      hatch_adjusted: false,
      hatch_actual: false,
      hatch_actual_pct: false,
      hatch_variance: false,
      inactive: true,
      not_reported: false,
      credit: false,
    };
  }
  const sig = r.variance_dollars != null
    ? signedMagnitudeMoney(r.variance_dollars)
    : { magnitude: null as any, direction: "even" as const };
  let variance_display: string | null = null;
  let variance_arrow: "↑" | "↓" | null = null;
  if (r.variance_dollars != null) {
    if (Math.abs(r.variance_dollars) < 1) variance_display = "on budget";
    else {
      variance_display = sig.magnitude ?? null;
      variance_arrow = sig.direction === "up" ? "↑" : "↓";
    }
  }
  return {
    variant: r.variant,
    line_code: r.line_code,
    label: r.label,
    indent: r.indent,
    budget_display: formatMoneyWhole(r.budget),
    target_pct_display: formatPct(r.target_pct),
    adjusted_display: formatMoneyWhole(r.adjusted),
    actual_display: fmtActualForRow(r),
    actual_pct_display: r.credit ? null : formatPct(r.actual_pct),
    variance_display,
    variance_arrow,
    verdict: r.verdict,
    hatch_target_pct: r.hatch_target_pct,
    hatch_adjusted: r.hatch_adjusted,
    hatch_actual: r.hatch_actual,
    hatch_actual_pct: r.hatch_actual_pct,
    hatch_variance: r.hatch_variance,
    inactive: false,
    not_reported: !r.reported && r.variant !== "total",
    credit: r.credit,
  };
}

export function formatPnlStatement(
  m: PnlStatementModel,
): PnlStatementDisplay {
  if (!m.render) {
    return {
      render: false,
      include_salary: m.include_salary,
      summary_rows: [],
      full_rows: [],
    };
  }
  return {
    render: true,
    include_salary: m.include_salary,
    summary_rows: m.summary_rows.map(formatRow),
    full_rows: m.full_rows.map(formatRow),
  };
}
