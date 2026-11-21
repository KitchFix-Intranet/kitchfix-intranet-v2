// src/lib/kpi/screen/cardsRow.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/CardsRow.js (783 lines).
//
// The three cards (Revenue, Cost of Goods, Gross Margin) that sit at
// the top of the closed-range Overview. v1 reads:
//   payload.cards                 - server-shipped per-card values
//   payload.hasTarget             - whether the account has budget targets
//   payload.revenueSourceState    - "planned" | ...
//   payload.rangeLabels           - horizon / period_span / etc.
//   payload.revenueModel          - "management_fee" | "per_meal" ...
//   payload.statementTotals       - period_budget + others
//   payload.scCountsWithoutDollars - revenue-is-absent state
//   payload.awaiting              - page-computed amber-pill trigger
//
// On a closed range (`period_state !== "open"`) the per-card payload
// already carries the final figures. The component applies:
//
//   REVENUE card:
//     actual          = card.hero_actual                 (number)
//     actual_display  = card.hero_actual_display         (string)
//     reference       = fytd/closed branch: card.budget_full_period
//                       fytd closed branch uses card.budget_to_date
//     actual_tone     = card.delta_direction mapped (revenue axis)
//     pill            = card.pill (tone + label passthrough)
//     variance_foot   = delta_dollars (actual - projection) + axis dir
//
//   COGS card:
//     actual          = card.hero_actual
//     adjusted        = card.budget_at_this_revenue      ("Adjusted" row)
//     pct_actual      = card.pct_of_revenue              (actual / rev)
//     pct_adjusted    = card.adjusted_pct_of_revenue
//                       || card.target_pct_display       (fallback)
//     pct_target      = card.target_pct_display          (shown in tip)
//     pill            = card.pill (or "Provisional"/wait on awaiting)
//     variance_foot   = (hero_actual - batr) + "Over/Under budget"
//
//   GROSS MARGIN card: same shape as COGS, with different labels.
//
// Scope is closed/this-year only; held/running code paths from v1
// (`PercentLeadCard.held`, `RevenueCard.confirmed_weeks_count`,
// PeriodBlock gauge) are explicitly OUT (train 2d-2).
//
// Return model: three cards each with budget / adjusted / actual /
// pct_actual / pct_target / gap_dollars / gap_points / verdict (plus
// a provisional flag so the formatter can still name the amber pill
// on closed-but-not-settled periods).
//
// All dollar + percent figures are numbers, never preformatted
// strings. The formatter below converts via shared helpers.

import {
  formatMoneyWhole,
  formatPct,
  gapDollarsRevenue,
  gapDollarsCost,
  gapDollarsMargin,
  gapPointsCost,
  gapPointsMargin,
  directionOfDelta,
} from "./formatting";

export type Verdict = "good" | "bad" | "even" | "none";
export type PillSide = "good" | "bad" | "even" | "wait" | "none";

export type CardsRowCard = {
  budget: number | null;
  adjusted: number | null;
  actual: number | null;
  pct_actual: number | null;
  pct_adjusted: number | null;
  pct_target: number | null;
  gap_dollars: number | null;
  gap_points: number | null;
  verdict: Verdict;
  provisional: boolean;
  // Server-shipped pill passthrough (Item 3 fix 2026-11-20).  v1
  // CardsRow Pill renders `payload.cards[i].pill.label` verbatim with
  // a tone class driven by `payload.cards[i].pill.tone`.  The V2 model
  // is the conduit for these two strings so the projector does not
  // read the payload directly.
  pill_label: string | null;
  pill_side: PillSide;
  // Suppression rule for the variance footer, consolidated here so
  // the projector doesn't have to re-derive it from the payload.
  //   - true when pill.tone is "neutral" (Contractual revenue, No
  //     target cogs/gm) because v1 VarianceFoot returns null in that
  //     case.
  //   - true when the amber "Provisional" pill lands on a closed-but-
  //     not-yet-verified cogs/gm card (same return-null path).
  //   - true when |gap_dollars| < 1 ("on target", no footer).
  footer_suppressed: boolean;
  // Hero actual tone, carried on the model per Kevin's 2026-11-20
  // ruling (train 2d-1 PR #94 bounce, item 2).  Mirrors v1 CardsRow:
  //   REVENUE (RevenueCard, closed-range scope - `confirmed_weeks_count`
  //   is null on closed; running branch is 2d-2): hero tone = mapped
  //   `card.delta_direction` ("good" / "bad" / "" => "none").
  //   COGS / GM (PercentLeadCard): hero tone = "wait" when the amber
  //   provisional branch is on (closed-but-not-yet-verified); else
  //   mapped `card.pill.tone`.
  // DOM capture regex treats "wait" as no colour class -> side "none"
  // on the capture.  The model carries the semantic word; the
  // projector maps "wait" -> "none" for compare against the capture.
  hero_side: PillSide;
};

export type CardsRowModel = {
  render: boolean;
  revenue_absent: boolean;      // sc_counts_without_dollars
  revenue: CardsRowCard;
  cogs: CardsRowCard;
  gross_margin: CardsRowCard;
};

function toNum(x: any): number | null {
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function verdictFromPill(pill: any): Verdict {
  const t = pill?.tone;
  if (t === "good") return "good";
  if (t === "bad") return "bad";
  if (t === "neutral") return "even";
  return "none";
}

function emptyCard(): CardsRowCard {
  return {
    budget: null,
    adjusted: null,
    actual: null,
    pct_actual: null,
    pct_adjusted: null,
    pct_target: null,
    gap_dollars: null,
    gap_points: null,
    verdict: "none",
    provisional: false,
    pill_label: null,
    pill_side: "none",
    footer_suppressed: true,
    hero_side: "none",
  };
}

function pillSideFromTone(tone: any, provisional: boolean): PillSide {
  if (provisional) return "wait";
  if (tone === "good") return "good";
  if (tone === "bad") return "bad";
  if (tone === "neutral") return "even";
  if (tone === "wait") return "wait";
  return "none";
}

export function buildCardsRow(payload: any): CardsRowModel {
  const cards = Array.isArray(payload?.cards) ? payload.cards : null;
  if (!cards) {
    return {
      render: false,
      revenue_absent: false,
      revenue: emptyCard(),
      cogs: emptyCard(),
      gross_margin: emptyCard(),
    };
  }
  const rangeKind = payload?.range?.kind ?? null;
  const awaiting = !!payload?.awaiting || payload?.status_line?.tone === "wait";
  const totals = payload?.statement_totals ?? {};
  const revenueAbsent = !!payload?.sc_counts_without_dollars;

  const revRaw = cards.find((c: any) => c?.key === "revenue");
  const cogsRaw = cards.find((c: any) => c?.key === "cogs");
  const gmRaw = cards.find((c: any) => c?.key === "gross_margin");

  // REVENUE. Reference on closed = budget_full_period; on fytd closed
  // = budget_to_date (sum of in-range period budgets). Both ship on
  // the card object; the page's selector picks between them.
  const revActual = toNum(revRaw?.hero_actual);
  const revBudgetFull = toNum(revRaw?.budget_full_period);
  const revBudgetToDate = toNum(revRaw?.budget_to_date);
  const revReference = rangeKind === "fytd" ? revBudgetToDate : revBudgetFull;
  // v1 variance footer uses card.delta_dollars (signed) for revenue.
  const revDelta = toNum(revRaw?.delta_dollars);
  const revPillSide = pillSideFromTone(revRaw?.pill?.tone, false);
  // v1 RevenueCard hero tone: closed-range scope only (train 2d-1).
  // v1 line 438-440: card.delta_direction === "good" -> good, "bad"
  // -> bad, else no tone class (= "none").  The running branch
  // (confirmed_weeks_count != null) is explicitly 2d-2 scope.
  const revDeltaDir = revRaw?.delta_direction;
  const revHeroSide: PillSide =
    revDeltaDir === "good" ? "good" : revDeltaDir === "bad" ? "bad" : "none";
  const revenue: CardsRowCard = {
    budget: revReference,
    adjusted: null,                        // revenue has no adjusted
    actual: revActual,
    pct_actual: null,
    pct_adjusted: null,
    pct_target: null,
    gap_dollars: revDelta,
    gap_points: null,
    verdict: verdictFromPill(revRaw?.pill),
    provisional: false,                    // revenue never goes amber
    pill_label: revRaw?.pill?.label != null ? String(revRaw.pill.label) : null,
    pill_side: revPillSide,
    footer_suppressed:
      revPillSide === "even" ||
      revPillSide === "wait" ||
      revDelta == null ||
      !Number.isFinite(revDelta) ||
      Math.abs(revDelta) < 1,
    hero_side: revHeroSide,
  };

  // COGS. actual = hero_actual; adjusted = budget_at_this_revenue;
  // pct_actual = pct_of_revenue; pct_adjusted = adjusted_pct_of_revenue
  //   with target_pct fallback (the component-level fallback).
  const cogsActual = toNum(cogsRaw?.hero_actual);
  const cogsAdjusted = toNum(cogsRaw?.budget_at_this_revenue);
  const cogsBudgetFull = toNum(cogsRaw?.budget_full_period);
  const cogsPctActual = toNum(cogsRaw?.pct_of_revenue);
  const cogsPctAdjusted =
    toNum(cogsRaw?.adjusted_pct_of_revenue) ??
    toNum(cogsRaw?.target_pct);
  const cogsPctTarget = toNum(cogsRaw?.target_pct);
  const cogsGapDollars =
    cogsActual != null && cogsAdjusted != null
      ? cogsActual - cogsAdjusted
      : null;
  const cogsGapPoints =
    cogsPctActual != null && cogsPctAdjusted != null
      ? cogsPctActual - cogsPctAdjusted
      : null;
  const cogsPillSide = pillSideFromTone(cogsRaw?.pill?.tone, awaiting);
  // v1 PercentLeadCard hero tone (line 568-573): `awaiting` -> "wait";
  // else `card.pill?.tone === "good"` -> good, "bad" -> bad, else no
  // class (= "none").  The capture regex treats "wait" as no colour -
  // the projector maps hero_side "wait" -> compare side "none".
  const cogsHeroSide: PillSide = awaiting
    ? "wait"
    : cogsRaw?.pill?.tone === "good"
      ? "good"
      : cogsRaw?.pill?.tone === "bad"
        ? "bad"
        : "none";
  const cogs: CardsRowCard = {
    budget: cogsBudgetFull,
    adjusted: cogsAdjusted,
    actual: cogsActual,
    pct_actual: cogsPctActual,
    pct_adjusted: cogsPctAdjusted,
    pct_target: cogsPctTarget,
    gap_dollars: cogsGapDollars,
    gap_points: cogsGapPoints,
    verdict: verdictFromPill(cogsRaw?.pill),
    provisional: awaiting,
    pill_label: cogsRaw?.pill?.label != null ? String(cogsRaw.pill.label) : null,
    pill_side: cogsPillSide,
    footer_suppressed:
      cogsPillSide === "even" ||
      cogsPillSide === "wait" ||
      cogsGapDollars == null ||
      !Number.isFinite(cogsGapDollars) ||
      Math.abs(cogsGapDollars) < 1,
    hero_side: cogsHeroSide,
  };

  // GROSS MARGIN. Same compute shape as COGS.
  const gmActual = toNum(gmRaw?.hero_actual);
  const gmAdjusted = toNum(gmRaw?.budget_at_this_revenue);
  const gmBudgetFull = toNum(gmRaw?.budget_full_period);
  const gmPctActual = toNum(gmRaw?.pct_of_revenue);
  const gmPctAdjusted =
    toNum(gmRaw?.adjusted_pct_of_revenue) ??
    toNum(gmRaw?.target_pct);
  const gmPctTarget = toNum(gmRaw?.target_pct);
  const gmGapDollars =
    gmActual != null && gmAdjusted != null
      ? gmActual - gmAdjusted
      : null;
  const gmGapPoints =
    gmPctActual != null && gmPctAdjusted != null
      ? gmPctActual - gmPctAdjusted
      : null;
  const gmPillSide = pillSideFromTone(gmRaw?.pill?.tone, awaiting);
  // Same v1 PercentLeadCard hero-tone rule as cogs.
  const gmHeroSide: PillSide = awaiting
    ? "wait"
    : gmRaw?.pill?.tone === "good"
      ? "good"
      : gmRaw?.pill?.tone === "bad"
        ? "bad"
        : "none";
  const gross_margin: CardsRowCard = {
    budget: gmBudgetFull,
    adjusted: gmAdjusted,
    actual: gmActual,
    pct_actual: gmPctActual,
    pct_adjusted: gmPctAdjusted,
    pct_target: gmPctTarget,
    gap_dollars: gmGapDollars,
    gap_points: gmGapPoints,
    verdict: verdictFromPill(gmRaw?.pill),
    provisional: awaiting,
    pill_label: gmRaw?.pill?.label != null ? String(gmRaw.pill.label) : null,
    pill_side: gmPillSide,
    footer_suppressed:
      gmPillSide === "even" ||
      gmPillSide === "wait" ||
      gmGapDollars == null ||
      !Number.isFinite(gmGapDollars) ||
      Math.abs(gmGapDollars) < 1,
    hero_side: gmHeroSide,
  };

  // statement_totals is reachable for consumers that want to render
  // the SG&A note; not part of the model itself in 2d-1.
  void totals;

  return {
    render: true,
    revenue_absent: revenueAbsent,
    revenue,
    cogs,
    gross_margin,
  };
}

// --- Formatter ----------------------------------------------------
//
// Kevin preference: Verdict = "good"/"bad"/"even"/"none" stays as a
// data word; display text + arrow derivation happens here.

export type CardsRowDisplayCard = {
  budget_display: string | null;
  adjusted_display: string | null;
  actual_display: string | null;
  pct_actual_display: string | null;
  pct_adjusted_display: string | null;
  pct_target_display: string | null;
  gap_dollars_display: string | null;
  gap_points_display: string | null;
  variance_label: string | null;     // "Over budget" / "Behind budget" / "Above projection"
  variance_arrow: "▲" | "▼" | null;
  variance_direction: "good" | "bad" | "neutral" | null;
  verdict: Verdict;
  provisional: boolean;
  // Pill passthrough from the model (Item 3).
  pill_label: string | null;
  pill_side: PillSide;
  footer_suppressed: boolean;
  // Hero actual tone passthrough (Item 2 fix 2026-11-20).
  hero_side: PillSide;
};

export type CardsRowDisplay = {
  render: boolean;
  revenue_absent: boolean;
  revenue: CardsRowDisplayCard;
  cogs: CardsRowDisplayCard;
  gross_margin: CardsRowDisplayCard;
};

function emptyDisplay(): CardsRowDisplayCard {
  return {
    budget_display: null,
    adjusted_display: null,
    actual_display: null,
    pct_actual_display: null,
    pct_adjusted_display: null,
    pct_target_display: null,
    gap_dollars_display: null,
    gap_points_display: null,
    variance_label: null,
    variance_arrow: null,
    variance_direction: null,
    verdict: "none",
    provisional: false,
    pill_label: null,
    pill_side: "none",
    footer_suppressed: true,
    hero_side: "none",
  };
}

function varianceInfo(
  kind: "revenue" | "cogs" | "gross_margin",
  delta: number | null,
  provisional: boolean,
): {
  label: string | null;
  arrow: "▲" | "▼" | null;
  direction: "good" | "bad" | "neutral" | null;
} {
  if (delta == null || !Number.isFinite(delta)) {
    return { label: null, arrow: null, direction: null };
  }
  if (Math.abs(delta) < 1) {
    return { label: null, arrow: null, direction: "neutral" };
  }
  const positive = delta > 0;
  const arrow: "▲" | "▼" = positive ? "▲" : "▼";
  let label: string;
  let direction: "good" | "bad";
  if (kind === "cogs") {
    label = positive ? "Over budget" : "Under budget";
    direction = positive ? "bad" : "good";
  } else if (kind === "gross_margin") {
    label = positive ? "Ahead of budget" : "Behind budget";
    direction = positive ? "good" : "bad";
  } else {
    label = positive ? "Above projection" : "Below projection";
    direction = positive ? "good" : "bad";
  }
  return {
    label,
    arrow,
    direction: provisional ? "neutral" : direction,
  };
}

function formatCard(
  kind: "revenue" | "cogs" | "gross_margin",
  c: CardsRowCard,
): CardsRowDisplayCard {
  const v = varianceInfo(kind, c.gap_dollars, c.provisional);
  let gap_points_display: string | null = null;
  if (c.gap_points != null) {
    if (kind === "cogs") gap_points_display = gapPointsCost(c.gap_points);
    else if (kind === "gross_margin") gap_points_display = gapPointsMargin(c.gap_points);
  }
  let gap_dollars_display: string | null = null;
  if (c.gap_dollars != null) {
    if (kind === "cogs") gap_dollars_display = gapDollarsCost(c.gap_dollars);
    else if (kind === "gross_margin") gap_dollars_display = gapDollarsMargin(c.gap_dollars);
    else gap_dollars_display = gapDollarsRevenue(c.gap_dollars);
  }
  // Axis-aware direction for accessibility - shared helper.
  const axis =
    kind === "cogs" ? "cost" : kind === "gross_margin" ? "margin" : "revenue";
  void directionOfDelta; // reserved for consumers that want the raw word
  void axis;
  return {
    budget_display: formatMoneyWhole(c.budget),
    adjusted_display: formatMoneyWhole(c.adjusted),
    actual_display: formatMoneyWhole(c.actual),
    pct_actual_display: formatPct(c.pct_actual),
    pct_adjusted_display: formatPct(c.pct_adjusted),
    pct_target_display: formatPct(c.pct_target),
    gap_dollars_display,
    gap_points_display,
    variance_label: v.label,
    variance_arrow: v.arrow,
    variance_direction: v.direction,
    verdict: c.verdict,
    provisional: c.provisional,
    pill_label: c.pill_label,
    pill_side: c.pill_side,
    footer_suppressed: c.footer_suppressed,
    hero_side: c.hero_side,
  };
}

export function formatCardsRow(m: CardsRowModel): CardsRowDisplay {
  if (!m.render) {
    return {
      render: false,
      revenue_absent: false,
      revenue: emptyDisplay(),
      cogs: emptyDisplay(),
      gross_margin: emptyDisplay(),
    };
  }
  return {
    render: true,
    revenue_absent: m.revenue_absent,
    revenue: formatCard("revenue", m.revenue),
    cogs: formatCard("cogs", m.cogs),
    gross_margin: formatCard("gross_margin", m.gross_margin),
  };
}
