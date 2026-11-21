// src/lib/kpi/screen/revenueLines.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/RevenueLines.js (262 lines).
//
// Rows of revenue lines beneath the three cards. Reads:
//   payload.statement_rows  - filter: section === "revenue" && !inactive
//   payload.cards[revenue]  - hero_actual (used as totalRevenue denom)
//   payload.range_composition - compose the "N verified · M live · K planned"
//   payload.revenue_source_state - "planned" | ...
//   payload.range_labels    - budget/actuals header strings
//
// Closed-range scope - showPeriodCol is false (open-period only). The
// revenue-line total on closed = sum(budget_to_date) and total
// revenue = cards[revenue].hero_actual, no "unreported budget still
// counts" subtle point from open ranges.
//
// Model vocabulary:
//   rows: [{ line_code, label, budget, actual, pct, tone, flags }]
//   total: { budget, actual, pct }   - pct is 100 iff actual != null
//   pill:  { text, tone }            - composition pill OR Verified/Live/Planned

import { formatMoneyWhole, formatPct, pctOf } from "./formatting";

export type RevenueLineFlag =
  | "sc_counts_without_dollars"
  | "inactive"              // present in the row but filtered out before model
  | "failed"
  | "not_active"
  | "no_budget"
  | "not_started";

export type RevenueRowTone = "good" | "bad" | "even" | "none";

export type RevenueLineRow = {
  line_code: string;
  label: string;
  budget: number | null;    // budget_to_date
  actual: number | null;    // row.actual or null when not reported
  reported: boolean;        // row.reported
  pct: number | null;       // actual as pct of total revenue
  tone: RevenueRowTone;
  flags: RevenueLineFlag[];
};

export type RevenueLinesModel = {
  render: boolean;
  rows: RevenueLineRow[];
  total: {
    budget: number | null;
    actual: number | null;
    pct: number | null;
  };
  pill: { text: string | null; tone: "neutral" | "good" | "bad" };
};

function pickFlags(raw: any): RevenueLineFlag[] {
  if (!Array.isArray(raw)) return [];
  const keep: RevenueLineFlag[] = [];
  const allow = new Set([
    "sc_counts_without_dollars",
    "failed",
    "not_active",
    "no_budget",
    "not_started",
  ]);
  for (const f of raw) if (allow.has(f)) keep.push(f as RevenueLineFlag);
  return keep;
}

function compositionText(rc: any): string | null {
  if (!rc) return null;
  if (!rc.periods_total || rc.periods_total <= 1) return null;
  const parts: string[] = [];
  if (rc.verified?.count) parts.push(`${rc.verified.count} verified`);
  if (rc.live?.count) parts.push(`${rc.live.count} live`);
  if (rc.planned?.count) parts.push(`${rc.planned.count} planned`);
  return parts.length ? parts.join(" · ") : null;
}

export function buildRevenueLines(payload: any): RevenueLinesModel {
  const srAll = Array.isArray(payload?.statement_rows)
    ? payload.statement_rows
    : null;
  if (!srAll) {
    return {
      render: false,
      rows: [],
      total: { budget: null, actual: null, pct: null },
      pill: { text: null, tone: "neutral" },
    };
  }
  const rawRows = srAll.filter((r: any) => {
    if (!r || r.section !== "revenue") return false;
    const flags = Array.isArray(r.flags) ? r.flags : [];
    if (flags.includes("inactive")) return false;
    return true;
  });
  if (rawRows.length === 0) {
    return {
      render: false,
      rows: [],
      total: { budget: null, actual: null, pct: null },
      pill: { text: null, tone: "neutral" },
    };
  }

  const revenueCard = Array.isArray(payload?.cards)
    ? payload.cards.find((c: any) => c?.key === "revenue")
    : null;
  const totalRevenue =
    revenueCard?.hero_actual != null ? Number(revenueCard.hero_actual) : null;

  const rows: RevenueLineRow[] = rawRows.map((r: any) => {
    const flags = pickFlags(r.flags);
    const budget = r.budget_to_date != null ? Number(r.budget_to_date) : null;
    const reported = r.reported !== false;
    const actual =
      reported && r.actual != null ? Number(r.actual) : null;
    const pct = pctOf(actual, totalRevenue);
    // Revenue lines on CLOSED range render without a per-row verdict
    // tone on the Actual column (v1 RevenueLines.js does not emit a
    // kpi-ov-good / kpi-ov-bad class on the actual cell, only the
    // pct-of-rev and the composition pill carry tone).  The 2026-11-20
    // strict-compare pass surfaced this: the model emitted a signed
    // delta-vs-budget tone that v1 never applies.  Set to "none".
    const tone: RevenueRowTone = "none";
    // Previously this block derived tone from (actual - budget); the
    // derivation is still correct arithmetically but the surface
    // doesn't render it on closed range.  If a consumer ever needs
    // the signed delta, derive it off the raw payload actual / budget
    // via the shared gapDollars helper.
    return {
      line_code: String(r.line_code),
      label: String(r.label ?? ""),
      budget,
      actual,
      reported,
      pct,
      tone,
      flags,
    };
  });

  // Total row. Any-budget-present guard gates the budget total.
  const anyBudget = rows.some((r) => r.budget != null);
  const totalBudget = anyBudget
    ? rows.reduce((s, r) => s + (r.budget != null ? r.budget : 0), 0)
    : null;
  const totalActual = totalRevenue;
  const totalPct = totalActual != null ? 100 : null;

  // Composition pill or the flat verdict pill.
  const isPlanned = payload?.revenue_source_state === "planned";
  const periodState = payload?.period_state;
  const composition = compositionText(payload?.range_composition);
  let pillText: string | null;
  let pillTone: "neutral" | "good" | "bad" = "neutral";
  if (composition) {
    pillText = composition;
    pillTone = "neutral";
  } else if (isPlanned) {
    pillText = "Planned";
    pillTone = "neutral";
  } else if (periodState === "verified") {
    pillText = "Verified";
    pillTone = "good";
  } else {
    pillText = "Live";
    pillTone = "good";
  }

  return {
    render: true,
    rows,
    total: { budget: totalBudget, actual: totalActual, pct: totalPct },
    pill: { text: pillText, tone: pillTone },
  };
}

// --- Formatter ----------------------------------------------------

export type RevenueLineDisplay = {
  line_code: string;
  label: string;
  budget_display: string | null;
  actual_display: string | null;
  pct_display: string | null;
  tone: RevenueRowTone;
  reported: boolean;
  flags: RevenueLineFlag[];
};

export type RevenueLinesDisplay = {
  render: boolean;
  rows: RevenueLineDisplay[];
  total: {
    budget_display: string | null;
    actual_display: string | null;
    pct_display: string | null;
  };
  pill: { text: string | null; tone: "neutral" | "good" | "bad" };
};

function formatRevenueRow(r: RevenueLineRow): RevenueLineDisplay {
  return {
    line_code: r.line_code,
    label: r.label,
    budget_display: formatMoneyWhole(r.budget),
    actual_display: r.reported ? formatMoneyWhole(r.actual) : null,
    pct_display: formatPct(r.pct),
    tone: r.tone,
    reported: r.reported,
    flags: r.flags,
  };
}

export function formatRevenueLines(m: RevenueLinesModel): RevenueLinesDisplay {
  if (!m.render) {
    return {
      render: false,
      rows: [],
      total: {
        budget_display: null,
        actual_display: null,
        pct_display: null,
      },
      pill: m.pill,
    };
  }
  return {
    render: true,
    rows: m.rows.map(formatRevenueRow),
    total: {
      budget_display: formatMoneyWhole(m.total.budget),
      actual_display: formatMoneyWhole(m.total.actual),
      pct_display: m.total.pct != null ? `${m.total.pct}%` : null,
    },
    pill: m.pill,
  };
}
