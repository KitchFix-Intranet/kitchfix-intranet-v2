// src/lib/kpi/screen/formatting.ts
//
// Train 2d-1. Screen-time formatting helpers specific to v1's closed-
// range Overview page. Shared money/pct/gap/direction helpers live in
// `src/lib/kpi/overview/formatting.ts`; this file only adds the small
// set of formatters that live INSIDE a component today (WeekRail MM/DD,
// unapproved-hour text, two-decimal percent for the rail-style
// envelope note, etc.) and have no caller yet in the shared set.
//
// All functions are pure, data-in / data-out, and never read a clock
// or a DOM. Values arrive as JS numbers or strings. Anywhere the
// shared helper already covers the shape (whole dollars, percent,
// delta-with-direction) this file re-exports it rather than
// duplicating.

import {
  formatMoneyWhole,
  formatPct,
  fmtWeekRange,
  formatDayLabel,
  pctOf,
  gapDollarsCost,
  gapDollarsRevenue,
  gapDollarsMargin,
  gapPointsCost,
  gapPointsRevenue,
  gapPointsMargin,
  directionOfDelta,
} from "../overview/formatting";

export {
  formatMoneyWhole,
  formatPct,
  fmtWeekRange,
  formatDayLabel,
  pctOf,
  gapDollarsCost,
  gapDollarsRevenue,
  gapDollarsMargin,
  gapPointsCost,
  gapPointsRevenue,
  gapPointsMargin,
  directionOfDelta,
};

// WeekRail month/day. v1 WeekRail.js:fmtMMDD. Pure string slice.
export function formatMMDD(iso: any): string {
  if (!iso) return "";
  const s = String(iso);
  return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

// Hours-left/awaiting copy for a week. v1 WeekRail + SettlingStrip
// both render `hours.toFixed(2)`. Null-tolerant.
export function formatHoursTwoDecimals(n: any): string | null {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Number(n).toFixed(2);
}

// People/person pluralisation for the SettlingStrip labour line.
// v1 inline: `${labour.people} ${labour.people === 1 ? "person" : "people"}`
export function formatPersonCount(n: any): string | null {
  if (n == null || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  return `${v} ${v === 1 ? "person" : "people"}`;
}

// Days pluralisation for the OverdueNudge entries. v1 inline:
// `${p.days_since_close} ${p.days_since_close === 1 ? "day" : "days"} ago`.
export function formatDaysCount(n: any): string | null {
  if (n == null || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  return `${v} ${v === 1 ? "day" : "days"}`;
}

// Weeks pluralisation. v1 signalCardModels.js:pluralWeeks.
export function pluralWeeks(n: any): string {
  return Number(n) === 1 ? "week" : "weeks";
}

// Signed-magnitude money. v1 PnlStatement.VarCell renders an arrow +
// absolute magnitude; this helper returns the two pieces so the
// formatting layer may compose them. direction: "up" when delta > 0,
// "down" when delta < 0, null when under $1.
export function signedMagnitudeMoney(delta: any): {
  magnitude: string;
  direction: "up" | "down" | "even";
} {
  if (delta == null || Number.isNaN(Number(delta))) {
    return { magnitude: "—", direction: "even" };
  }
  const d = Number(delta);
  if (Math.abs(d) < 1) return { magnitude: "on budget", direction: "even" };
  return {
    magnitude: formatMoneyWhole(Math.abs(d)) || "—",
    direction: d > 0 ? "up" : "down",
  };
}

// Hours with thousands separator + two decimals. v1 labor/lib/
// formatting.js:fmtHrs. Pure; no clock, no locale surprises because
// toLocaleString is deterministic on numbers with fixed fraction
// digits.
export function fmtHrs(v: any): string | null {
  if (v == null) return null;
  return Number(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Whole-hours rounded; used by the LaborLedger header summary. v1
// LaborLedger.js:headerSummary rounds then adds thousands-sep.
export function fmtHrsRounded(v: any): string | null {
  if (v == null) return null;
  return Math.round(Number(v)).toLocaleString("en-US");
}
