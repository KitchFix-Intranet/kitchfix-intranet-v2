// src/lib/kpi/rangeSnap.ts
//
// Cross-board range-alignment guard ([name], 2026-09-02).
//
// Rule shipped in the "retire custom and rolling ranges" PR: every
// range the KPI platform resolves must be either FYTD or aligned to
// fiscal-period boundaries. A range that partly overlaps a closed
// period reports revenue at period grain (pnl_actuals is period-
// grain) while labor + purchasing count in-range days - the two-
// horizon defect that produced 65.7% gross margin on TBR - FL for
// 08/03-08/30.
//
// This helper is the ONE place that decides:
//   - "is (start, end) aligned to period boundaries?"
//   - "what do we snap it to when it is not?"
//
// All three routes (Overview, Labor, Purchasing) call this after
// reading the URL and before touching data. The client is the front
// door; this is the load-bearing gate.
//
// Snap policy (from the prompt):
//   "A URL carrying start/end that do not match a period boundary or
//    FYTD resolves to the period containing `end`, and the chip
//    names what happened."
//
// A range is considered aligned iff:
//   1. (start, end) == fy.startISO, today         -> FYTD
//   2. start == periodStartISO(A) AND end == periodEndISO(B)
//      for some A, B in [1..13] with A <= B       -> single or multi-period
//
// Otherwise: snap to the fiscal period containing `end`. Non-fiscal
// bounds outside fy are clamped to the boundary period (e.g., end >
// fy.endISO snaps to P13).

import {
  periodStartISO,
  periodEndISO,
} from "@/lib/kpi/labor/periods";
import type { FiscalYear } from "@/lib/kpi/shared/fiscalYear";

const PERIODS = Array.from({ length: 13 }, (_: any, i: any): any => i + 1);

// Which period contains an arbitrary ISO date. Returns null if the
// date is outside fy boundaries.
export function periodContainingDate(iso: any, fy: FiscalYear): any {
  if (!iso) return null;
  for (const p of PERIODS) {
    const s = periodStartISO(p, fy);
    const e = periodEndISO(p, fy);
    if (s && e && iso >= s && iso <= e) return p;
  }
  if (iso < fy.startISO) return 1;
  if (iso > fy.endISO) return 13;
  return null;
}

function periodStartingAt(iso: any, fy: FiscalYear): any {
  for (const p of PERIODS) if (periodStartISO(p, fy) === iso) return p;
  return null;
}
function periodEndingAt(iso: any, fy: FiscalYear): any {
  for (const p of PERIODS) if (periodEndISO(p, fy) === iso) return p;
  return null;
}

/**
 * Resolve a URL-supplied (start, end) pair to an aligned range,
 * snapping when necessary. `today` is required to distinguish
 * "FYTD" (fy.startISO to today) from an aligned multi-period range
 * that happens to end today.
 */
export function snapRange(start: any, end: any, today: any, fy: FiscalYear): any {
  if (!start || !end) {
    return {
      start: fy.startISO, end: today,
      kind: "fytd", period_no: null,
      start_period_no: null, end_period_no: null,
      snapped: false, snapped_from: null,
    };
  }

  // 1. FYTD: fy.startISO to today exactly.
  if (start === fy.startISO && end === today) {
    return {
      start, end,
      kind: "fytd", period_no: null,
      start_period_no: null, end_period_no: null,
      snapped: false, snapped_from: null,
    };
  }

  // 2. Aligned to period boundaries.
  const startP = periodStartingAt(start, fy);
  const endP = periodEndingAt(end, fy);
  if (startP != null && endP != null && startP <= endP) {
    if (startP === endP) {
      return {
        start, end,
        kind: "period", period_no: startP,
        start_period_no: startP, end_period_no: endP,
        snapped: false, snapped_from: null,
      };
    }
    return {
      start, end,
      kind: "periods", period_no: null,
      start_period_no: startP, end_period_no: endP,
      snapped: false, snapped_from: null,
    };
  }

  // 3. Snap to the period containing `end` (per [name]'s rule 4).
  const p = periodContainingDate(end, fy) || periodContainingDate(start, fy) || 1;
  return {
    start: periodStartISO(p, fy),
    end: periodEndISO(p, fy),
    kind: "period", period_no: p,
    start_period_no: p, end_period_no: p,
    snapped: true,
    snapped_from: { start, end },
  };
}
