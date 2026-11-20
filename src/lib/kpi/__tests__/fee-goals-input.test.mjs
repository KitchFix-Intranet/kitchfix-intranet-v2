// Train 2c: `feeGoals` is a required caller input to getPurchasing -
// the engine does not fetch or own the annual-management-fee table. A
// pass-through account's mgmt_fee board reads goal shape from the
// `feeGoals[account]` entry (annual / clientLabel / taxCaveatState)
// and derives:
//
//   - client_label:       goalRow.clientLabel || account
//   - tax_caveat_state:   goalRow.taxCaveatState || null
//   - crossed_period_no:  the period at which cumulative reimbursable
//                         spend first meets or exceeds goalRow.annual
//                         (null when no goal, zero goal, or not yet
//                          crossed)
//
// Made-up data only. No real account's annual goal, no real vendor,
// no real reimbursable amount. The stub supa returns at most ONE
// reimbursable row (made-up amount) to exercise the crossing path.
//
// Pre-cutover `today` is used throughout to avoid the
// paginateInvoiceSubmissions "Invalid time value" branch (see the
// defect flagged in the author's final report).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPurchasing } from "../entry.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

const FY2026 = buildFiscalYear(2026, [
  { period_no: 1,  start_date: "2025-12-29", end_date: "2026-01-25" },
  { period_no: 2,  start_date: "2026-01-26", end_date: "2026-02-22" },
  { period_no: 3,  start_date: "2026-02-23", end_date: "2026-03-22" },
  { period_no: 4,  start_date: "2026-03-23", end_date: "2026-04-19" },
  { period_no: 5,  start_date: "2026-04-20", end_date: "2026-05-17" },
  { period_no: 6,  start_date: "2026-05-18", end_date: "2026-06-14" },
  { period_no: 7,  start_date: "2026-06-15", end_date: "2026-07-12" },
  { period_no: 8,  start_date: "2026-07-13", end_date: "2026-08-09" },
  { period_no: 9,  start_date: "2026-08-10", end_date: "2026-09-06" },
  { period_no: 10, start_date: "2026-09-07", end_date: "2026-10-04" },
  { period_no: 11, start_date: "2026-10-05", end_date: "2026-11-01" },
  { period_no: 12, start_date: "2026-11-02", end_date: "2026-11-29" },
  { period_no: 13, start_date: "2026-11-30", end_date: "2026-12-27" },
]);

// Chainable supa stub. By default every chain resolves to empty rows.
// If `weeklyRow` is supplied, the `v_purchasing_by_site_week` table
// returns [weeklyRow] (so goalFytdSpent crosses the goal).
function supaStub({ weeklyRow = null } = {}) {
  const makeBuilder = (table) => {
    const b = {};
    const noop = () => b;
    let resolvedValue = { data: [], error: null };
    for (const m of [
      "select", "eq", "neq", "in", "gte", "lte", "lt", "gt",
      "order", "not", "or", "filter", "ilike", "like", "is", "match",
      "limit", "range",
    ]) b[m] = noop;
    b.maybeSingle = () => { resolvedValue = { data: null, error: null }; return b; };
    b.single = b.maybeSingle;
    if (weeklyRow && table === "v_purchasing_by_site_week") {
      resolvedValue = { data: [weeklyRow], error: null };
    }
    b.then = (resolve, reject) =>
      Promise.resolve(resolvedValue).then(resolve, reject);
    return b;
  };
  return {
    from(table) { return makeBuilder(table); },
    rpc() { return makeBuilder("rpc"); },
  };
}

const corporate = { role: "corporate", scope: null, can_see_salary: true };

describe("getPurchasing honours a made-up feeGoals input", () => {
  it("pass-through account carries clientLabel + taxCaveatState from feeGoals", async () => {
    const res = await getPurchasing({
      supa: supaStub(),
      today: "2026-08-01",
      now: new Date("2026-08-01T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - OH" },     // pass-through
      feeGoals: {
        "CIN - OH": { annual: 100000, clientLabel: "Made-Up Client Name", taxCaveatState: "MU" },
        "STL - MO": { annual: 50000, clientLabel: "Made-Up STL", taxCaveatState: "MU" },
      },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.mgmt_fee, "mgmt_fee board present for a pass-through account");
    assert.strictEqual(res.body.mgmt_fee.client_label, "Made-Up Client Name");
    assert.strictEqual(res.body.mgmt_fee.tax_caveat_state, "MU");
    assert.strictEqual(res.body.mgmt_fee.crossed_period_no, null,
      "no spend returned by stub -> goal is not crossed");
    assert.strictEqual(res.body.mgmt_fee.goal_fytd_spent, 0);
  });

  it("pass-through account with NO feeGoals falls back to account label + null state", async () => {
    const res = await getPurchasing({
      supa: supaStub(),
      today: "2026-08-01",
      now: new Date("2026-08-01T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - OH" },
      // feeGoals omitted - the shape v1 returns for an account absent
      // from the goal table: client_label echoes the account_key, and
      // tax_caveat_state + crossed_period_no are both null.
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.mgmt_fee, "mgmt_fee still present (pass-through)");
    assert.strictEqual(res.body.mgmt_fee.client_label, "CIN - OH");
    assert.strictEqual(res.body.mgmt_fee.tax_caveat_state, null);
    assert.strictEqual(res.body.mgmt_fee.crossed_period_no, null);
  });

  it("pass-through account with feeGoals={} behaves the same as no feeGoals", async () => {
    const res = await getPurchasing({
      supa: supaStub(),
      today: "2026-08-01",
      now: new Date("2026-08-01T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - OH" },
      feeGoals: {},
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mgmt_fee.client_label, "CIN - OH");
    assert.strictEqual(res.body.mgmt_fee.tax_caveat_state, null);
    assert.strictEqual(res.body.mgmt_fee.crossed_period_no, null);
  });

  it("goal crossed in P4 when reimbursable spend exceeds annual goal", async () => {
    // Made-up P4 reimbursable row: 500 units; annual goal = 1 unit.
    // Cumulative crosses in period 1? No - the stub row lands in P4
    // (week_start 2026-03-23 is P4). Periods 1-3 have zero spend, so
    // cumulative stays at 0 through P3 then jumps to 500 at P4 and
    // crosses the 1-unit goal there. Verifies the crossing walks
    // periods_trend in order.
    const res = await getPurchasing({
      supa: supaStub({
        weeklyRow: {
          account_key: "CIN - OH",
          week_start: "2026-03-23",
          week_end: "2026-03-29",
          gl_line_code: "1374.1",
          gl_bucket: "reimbursable",
          amount: 500,
          line_count: 1,
          bill_count: 1,
          paid_amount: 500,
        },
      }),
      today: "2026-08-01",
      now: new Date("2026-08-01T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - OH" },
      feeGoals: { "CIN - OH": { annual: 1, clientLabel: "Made-Up", taxCaveatState: "MU" } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mgmt_fee.crossed_period_no, 4,
      "crossing happens in P4 once reimbursable spend exceeds the 1-unit annual goal");
    assert.strictEqual(res.body.mgmt_fee.goal_fytd_spent, 500);
  });

  it("non-pass-through account returns mgmt_fee: null regardless of feeGoals shape", async () => {
    // TBR - FL is at-risk (not in PASS_THROUGH_ACCOUNTS); the entry
    // never populates mgmt_fee for it. Passing a goal row through
    // feeGoals should still produce mgmt_fee: null.
    const res = await getPurchasing({
      supa: supaStub(),
      today: "2026-08-01",
      now: new Date("2026-08-01T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "TBR - FL" },
      feeGoals: { "TBR - FL": { annual: 100000, clientLabel: "Made-Up", taxCaveatState: "MU" } },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mgmt_fee, null,
      "non-pass-through accounts do not carry mgmt_fee even with a goal row");
  });
});
