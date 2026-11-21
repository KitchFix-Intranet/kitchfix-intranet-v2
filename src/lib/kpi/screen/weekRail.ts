// src/lib/kpi/screen/weekRail.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/WeekRail.js (196 lines).
//
// WeekRail is the per-week 4-card rail. v1 mounts it only on closed
// single-period (payload.week_rail non-null). Each tile:
//
//   state label  (via tileStateLabel)
//     in_progress            -> "running"
//     !in_progress && basis confirmed -> "confirmed"
//     else                  -> "forecast"
//
//   fields: meal_revenue, fee_prorate, week_revenue, cost_target,
//   cost_landed (dash on forecast), labor_landed, purchasing_landed,
//   unapproved_hours
//
//   invoices_landed = (running_week_no - week_no) >= 2, on non-forecast
//     weeks only
//   labor state caveats: pending (unapproved_hours > 0) OR approved
//     (unapproved_hours == 0 AND labor_landed > 0)
//
// Kevin ruling 2026-11-20 (PR body): labor_landed / purchasing_landed
// / unapproved_hours are held once; both this surface and the labor/
// purchasing folds consume the same payload fields. v1 WeekRail reads
// `week_rail.weeks[].labor_landed`; v1 LaborLedger consumes
// `labor.actuals[]` through `buildWeekAggregates` which sums
// `amount` by week. See the report at the bottom for the
// cross-site comparison.

import { formatMoneyWhole, formatMMDD, formatHoursTwoDecimals } from "./formatting";

export type WeekRailTileState = "running" | "confirmed" | "forecast";

export type WeekRailTile = {
  week_no: number;
  week_start: string;
  week_end: string;
  state: "closed" | "in_progress" | "not_started" | string;
  revenue_basis: "confirmed" | "forecast" | "partial" | null;
  variant: WeekRailTileState;
  meal_revenue: number | null;
  fee_prorate: number | null;
  week_revenue: number | null;
  cost_target: number | null;
  cost_landed: number | null;
  labor_landed: number | null;
  purchasing_landed: number | null;
  unapproved_hours: number | null;
  invoices_landed: boolean;        // true when (running_week - week) >= 2
  show_invoice_caveat: boolean;    // not forecast
  show_labor_pending_caveat: boolean;
  show_labor_approved_caveat: boolean;
};

export type WeekRailModel = {
  render: boolean;
  period_no: number | null;
  running_week_no: number | null;
  confirmed_count: number;
  total_count: number;
  tiles: WeekRailTile[];
};

function tileVariant(state: any, basis: any): WeekRailTileState {
  if (state === "in_progress") return "running";
  if (basis === "confirmed") return "confirmed";
  return "forecast";
}

export function buildWeekRail(payload: any): WeekRailModel {
  const wr = payload?.week_rail;
  if (!wr || !Array.isArray(wr.weeks) || wr.weeks.length === 0) {
    return {
      render: false,
      period_no: null,
      running_week_no: null,
      confirmed_count: 0,
      total_count: 0,
      tiles: [],
    };
  }
  const running_week_no =
    wr.running_week_no != null ? Number(wr.running_week_no) : null;
  const tiles: WeekRailTile[] = wr.weeks.map((w: any) => {
    const variant = tileVariant(w.state, w.revenue_basis);
    const isForecast = w.state === "not_started";
    const invoicesLanded =
      running_week_no != null && w.week_no != null
        ? Number(running_week_no) - Number(w.week_no) >= 2
        : false;
    const unapp = w.unapproved_hours != null ? Number(w.unapproved_hours) : 0;
    const laborLanded =
      w.labor_landed != null ? Number(w.labor_landed) : null;
    return {
      week_no: Number(w.week_no),
      week_start: String(w.week_start),
      week_end: String(w.week_end),
      state: String(w.state ?? ""),
      revenue_basis: (w.revenue_basis as any) ?? null,
      variant,
      meal_revenue: w.meal_revenue != null ? Number(w.meal_revenue) : null,
      fee_prorate: w.fee_prorate != null ? Number(w.fee_prorate) : null,
      week_revenue: w.week_revenue != null ? Number(w.week_revenue) : null,
      cost_target: w.cost_target != null ? Number(w.cost_target) : null,
      cost_landed:
        isForecast ? null : w.cost_landed != null ? Number(w.cost_landed) : null,
      labor_landed: laborLanded,
      purchasing_landed:
        w.purchasing_landed != null ? Number(w.purchasing_landed) : null,
      unapproved_hours: w.unapproved_hours != null ? Number(w.unapproved_hours) : null,
      invoices_landed: invoicesLanded,
      show_invoice_caveat: !isForecast,
      show_labor_pending_caveat: !isForecast && unapp > 0,
      show_labor_approved_caveat:
        !isForecast && unapp === 0 && (laborLanded ?? 0) > 0,
    };
  });
  const confirmed_count = tiles.filter((t) => t.variant === "confirmed").length;
  return {
    render: true,
    period_no: wr.period_no != null ? Number(wr.period_no) : null,
    running_week_no,
    confirmed_count,
    total_count: tiles.length,
    tiles,
  };
}

// --- Formatter ----------------------------------------------------

export type WeekRailTileDisplay = {
  week_no: number;
  state_label: string;                // "running" | "confirmed" | "forecast"
  variant: WeekRailTileState;
  date_range: string;                 // "MM/DD – MM/DD"
  meal_label: string;                 // "Confirmed meals" | "Forecast meals"
  meal_display: string | null;
  fee_display: string | null;
  week_revenue_display: string | null;
  cost_target_display: string | null;
  cost_landed_display: string | null; // "—" on forecast
  vsline_display: string | null;      // "landed of target" or plan sentence
  invoice_caveat: string | null;
  labor_caveat: string | null;
};

export type WeekRailDisplay = {
  render: boolean;
  period_no: number | null;
  pill_text: string;
  pill_tone: "good" | "neutral";
  tiles: WeekRailTileDisplay[];
};

function stateLabel(v: WeekRailTileState): string {
  if (v === "running") return "running";
  if (v === "confirmed") return "confirmed";
  return "forecast";
}

export function formatWeekRail(m: WeekRailModel): WeekRailDisplay {
  if (!m.render) {
    return {
      render: false,
      period_no: null,
      pill_text: "",
      pill_tone: "neutral",
      tiles: [],
    };
  }
  const pill_text = `${m.confirmed_count} of ${m.total_count} weeks confirmed`;
  const pill_tone: "good" | "neutral" =
    m.confirmed_count === m.total_count ? "good" : "neutral";
  const tiles = m.tiles.map((t): WeekRailTileDisplay => {
    const label = stateLabel(t.variant);
    const date_range = `${formatMMDD(t.week_start)} – ${formatMMDD(t.week_end)}`;
    const meal_label =
      t.revenue_basis === "confirmed" ? "Confirmed meals" : "Forecast meals";
    const costTargetTxt = formatMoneyWhole(t.cost_target) ?? "—";
    const costLandedTxt =
      t.variant === "forecast" ? "—" : formatMoneyWhole(t.cost_landed) ?? "—";
    const vsline_display =
      t.variant === "forecast"
        ? `plan to ${costTargetTxt}`
        : `${costLandedTxt} of ${costTargetTxt}`;
    let invoice_caveat: string | null = null;
    if (t.show_invoice_caveat) {
      invoice_caveat = t.invoices_landed
        ? "Invoices landed"
        : "Invoices still arriving";
    }
    let labor_caveat: string | null = null;
    if (t.show_labor_pending_caveat) {
      const hrs = formatHoursTwoDecimals(t.unapproved_hours);
      labor_caveat = hrs != null ? `${hrs} hrs pending approval` : null;
    } else if (t.show_labor_approved_caveat) {
      labor_caveat = "Labor approved";
    }
    return {
      week_no: t.week_no,
      state_label: label,
      variant: t.variant,
      date_range,
      meal_label,
      meal_display: formatMoneyWhole(t.meal_revenue) ?? "—",
      fee_display: formatMoneyWhole(t.fee_prorate) ?? "—",
      week_revenue_display: formatMoneyWhole(t.week_revenue) ?? "—",
      cost_target_display: costTargetTxt,
      cost_landed_display: costLandedTxt,
      vsline_display,
      invoice_caveat,
      labor_caveat,
    };
  });
  return {
    render: true,
    period_no: m.period_no,
    pill_text,
    pill_tone,
    tiles,
  };
}
