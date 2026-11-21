// src/lib/kpi/screen/alsoTracked.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/AlsoTracked.js (154 lines).
//
// Three lines not part of gross margin or cost of goods:
//   5002.1 Gen. Repair & Maintenance
//   5002.5 Equipment
//   5017.3 Perks
//
// Payload contract: payload.also_tracked = [{ line_code, label,
//   actual, budget, actual_display, budget_display, variance,
//   reported, flags? }]. Empty / missing -> render false.
//
// v1 Row() logic:
//   bothNullish  = (actual null||0) AND (budget null||0)
//   noBudget     = budget nullish AND actual non-zero
//   variance cell:
//     - bothNullish          -> empty phrase ("no activity"|"no spend")
//     - noBudget             -> actual as-is (neutral)
//     - |variance| < 1       -> "on budget"
//     - variance >= 0 cost   -> "over" (bad); negative -> "under" (good)
//   Closed branch uses emptyPhrase = "no spend".

import { formatMoneyWhole, gapDollarsCost } from "./formatting";

export type AlsoTrackedState =
  | "value"
  | "no_budget"
  | "empty";

export type AlsoTrackedRowTone = "good" | "bad" | "even" | "none";

export type AlsoTrackedRow = {
  line_code: string;
  label: string;
  state: AlsoTrackedState;
  budget: number | null;
  actual: number | null;
  variance: number | null;        // negative = under (good); positive = over (bad)
  tone: AlsoTrackedRowTone;
  reported: boolean;
};

export type AlsoTrackedModel = {
  render: boolean;
  rows: AlsoTrackedRow[];
};

export function buildAlsoTracked(payload: any): AlsoTrackedModel {
  const list = Array.isArray(payload?.also_tracked) ? payload.also_tracked : [];
  if (list.length === 0) return { render: false, rows: [] };
  const rows: AlsoTrackedRow[] = list.map((r: any) => {
    const budget = r.budget != null ? Number(r.budget) : null;
    const actual = r.actual != null ? Number(r.actual) : null;
    const variance = r.variance != null ? Number(r.variance) : null;
    const bothNullish =
      (actual == null || actual === 0) && (budget == null || budget === 0);
    const noBudget =
      (budget == null || budget === 0) && actual != null && actual !== 0;

    let state: AlsoTrackedState;
    let tone: AlsoTrackedRowTone = "none";
    if (bothNullish) {
      state = "empty";
    } else if (noBudget) {
      state = "no_budget";
    } else {
      state = "value";
      if (variance != null) {
        if (Math.abs(variance) < 1) tone = "even";
        else tone = variance <= 0 ? "good" : "bad";
      }
    }
    return {
      line_code: String(r.line_code),
      label: String(r.label ?? ""),
      state,
      budget,
      actual,
      variance,
      tone,
      reported: r.reported !== false,
    };
  });
  return { render: true, rows };
}

// --- Formatter ----------------------------------------------------

export type AlsoTrackedRowDisplay = {
  line_code: string;
  label: string;
  budget_display: string | null;
  actual_display: string | null;
  variance_display: string | null;   // "$X under"/"$X over"/"on budget"/null
  tone: AlsoTrackedRowTone;
  empty_phrase: string | null;       // on bothNullish - "no spend" (closed)
};

export type AlsoTrackedDisplay = {
  render: boolean;
  rows: AlsoTrackedRowDisplay[];
};

export function formatAlsoTracked(
  m: AlsoTrackedModel,
): AlsoTrackedDisplay {
  if (!m.render) return { render: false, rows: [] };
  const rows: AlsoTrackedRowDisplay[] = m.rows.map((r) => {
    if (r.state === "empty") {
      return {
        line_code: r.line_code,
        label: r.label,
        budget_display: null,
        actual_display: null,
        variance_display: null,
        tone: "none",
        empty_phrase: "no spend",
      };
    }
    if (r.state === "no_budget") {
      // v1 AlsoTracked.js:68 renders actual_display in the variance
      // column (neutral tone) when budget is nullish but actual is
      // non-zero. Carry the same value through so the vs-budget cell
      // isn't blank. Variance is still semantically undefined (no
      // budget to compare against); the display mirrors the actual.
      const actualD = formatMoneyWhole(r.actual);
      return {
        line_code: r.line_code,
        label: r.label,
        budget_display: null,
        actual_display: actualD,
        variance_display: actualD,
        tone: "none",
        empty_phrase: null,
      };
    }
    return {
      line_code: r.line_code,
      label: r.label,
      budget_display: formatMoneyWhole(r.budget),
      actual_display: formatMoneyWhole(r.actual),
      variance_display: gapDollarsCost(r.variance),
      tone: r.tone,
      empty_phrase: null,
    };
  });
  return { render: true, rows };
}
