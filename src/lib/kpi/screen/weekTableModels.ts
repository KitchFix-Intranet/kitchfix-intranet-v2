// src/lib/kpi/screen/weekTableModels.ts
//
// Train 2d-1. MOVE WHOLE from v1:
//   src/app/kpi/labor/lib/weekTableModels.js (106 lines).
//
// Pure-function builder for the portfolio-view aggregate map. Same
// body as v1 except for the TypeScript annotations (`any` liberally).
// The twin test in __tests__/weekTableModels.test.mjs runs v1's own
// function at the pin against this one on a hand-built actuals
// fixture and asserts equivalence.

/**
 * Group raw actuals rows by (week_start, account_key) for the
 * aggregate week-table drill-down.
 */
export function buildMemberByWeekAndAcct(
  actuals: any,
  mode: any,
): Map<string, Map<string, any>> {
  const out: Map<string, Map<string, any>> = new Map();
  if (mode !== "aggregate") return out;
  if (!actuals || actuals.length === 0) return out;
  for (const r of actuals) {
    const wk = r.week_start;
    if (!wk) continue;
    let per = out.get(wk);
    if (!per) {
      per = new Map();
      out.set(wk, per);
    }
    const key = r.account_key;
    if (!key) continue;
    const cur = per.get(key) || {
      amount: 0,
      hours: 0,
      ot: 0,
      hol: 0,
      unpriced: 0,
      draft_hours: 0,
      hours_regular: 0,
      hours_overtime: 0,
      hours_double_time: 0,
      hours_premium_other: 0,
      dollars_regular: 0,
      dollars_overtime: 0,
      dollars_double_time: 0,
      dollars_premium_other: 0,
      anomaly_no_clockout: 0,
      anomaly_under_1h: 0,
      anomaly_over_16h: 0,
      states: [] as any[],
    };
    cur.amount += Number(r.amount || 0);
    cur.hours +=
      Number(r.hours_regular || 0) +
      Number(r.hours_overtime || 0) +
      Number(r.hours_double_time || 0);
    cur.ot += Number(r.hours_overtime || 0);
    cur.hol += Number(r.hours_double_time || 0);
    cur.hours_regular += Number(r.hours_regular || 0);
    cur.hours_overtime += Number(r.hours_overtime || 0);
    cur.hours_double_time += Number(r.hours_double_time || 0);
    cur.hours_premium_other += Number(r.hours_premium_other || 0);
    cur.dollars_regular += Number(r.dollars_regular || 0);
    cur.dollars_overtime += Number(r.dollars_overtime || 0);
    cur.dollars_double_time += Number(r.dollars_double_time || 0);
    cur.dollars_premium_other += Number(r.dollars_premium_other || 0);
    cur.unpriced += Number(r.hours_without_dollars || 0);
    cur.draft_hours += Number(r.draft_hours || 0);
    cur.anomaly_no_clockout += Number(r.anomaly_no_clockout || 0);
    cur.anomaly_under_1h += Number(r.anomaly_under_1h || 0);
    cur.anomaly_over_16h += Number(r.anomaly_over_16h || 0);
    cur.states.push(r.coverage_state);
    per.set(key, cur);
  }
  return out;
}
