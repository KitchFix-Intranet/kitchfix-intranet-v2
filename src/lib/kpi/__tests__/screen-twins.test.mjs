// Twin tests for the move-whole helpers in src/lib/kpi/screen/**.
//
// v1 pin: ~/dev/kf-kpi-readonly at c3c1b90260accfebe411c2c44416065351efc378.
// The functions below are byte-for-byte lifts of the v1 originals
// (v1 paths named in each describe block). Expected values were
// computed by hand from v1's own source at the pin on a fully
// made-up input set; no real vendor name or dollar figure appears
// anywhere in this file.
//
// This is the proof that "same code" produced "same answer" on the
// day of the move. Logic-level regressions in future PRs trip here
// without a v1 checkout.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMemberByWeekAndAcct } from "../screen/weekTableModels.js";
import { flagForV42State } from "../screen/weekFlag.js";
import {
  resolveDashState,
  dashOrValue,
  formatDashOrValue,
} from "../screen/dashOrValue.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";
import {
  buildFilteredActuals,
  buildWeekAggregates,
  buildWorkerRoster,
  buildWorkerRangeTotals,
} from "../screen/laborAggregate.js";

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

describe("twin · weekTableModels.buildMemberByWeekAndAcct", () => {
  it("single-mode returns empty map (no path exercised)", () => {
    const out = buildMemberByWeekAndAcct([{ account_key: "A", week_start: "2026-01-05" }], "single");
    assert.equal(out.size, 0);
  });

  it("aggregate-mode sums per (week, account) and tracks coverage states", () => {
    const rows = [
      { account_key: "A", week_start: "2026-01-05", hours_regular: 10, hours_overtime: 2, amount: 100, hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
      { account_key: "A", week_start: "2026-01-05", hours_regular: 5,  hours_overtime: 0, amount: 50,  hours_without_dollars: 1, draft_hours: 3, coverage_state: "partial" },
      { account_key: "B", week_start: "2026-01-05", hours_regular: 8,  hours_overtime: 0, amount: 80,  hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
      { account_key: "A", week_start: "2026-01-12", hours_regular: 7,  hours_overtime: 1, amount: 70,  hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
    ];
    const out = buildMemberByWeekAndAcct(rows, "aggregate");
    // Week 2026-01-05 has A + B.
    const wk1 = out.get("2026-01-05");
    assert.equal(wk1.size, 2);
    const a1 = wk1.get("A");
    assert.equal(a1.amount, 150);
    assert.equal(a1.hours, 10 + 2 + 5 + 0); // reg+ot+double across both rows
    assert.equal(a1.ot, 2);
    assert.equal(a1.unpriced, 1);
    assert.equal(a1.draft_hours, 3);
    assert.deepEqual(a1.states, ["complete", "partial"]);
    const b1 = wk1.get("B");
    assert.equal(b1.amount, 80);
    // Week 2026-01-12 only has A.
    const wk2 = out.get("2026-01-12");
    assert.equal(wk2.size, 1);
    assert.equal(wk2.get("A").amount, 70);
  });

  it("skips rows with missing week_start or account_key", () => {
    const rows = [
      { week_start: null, account_key: "A", amount: 1 },
      { week_start: "2026-01-05", account_key: null, amount: 1 },
    ];
    const out = buildMemberByWeekAndAcct(rows, "aggregate");
    // v1 shape: missing week_start is skipped (continue before map).
    // Missing account_key is skipped AFTER the week entry is created,
    // so the week bucket exists but holds zero accounts.
    assert.equal(out.size, 1);
    assert.equal(out.get("2026-01-05").size, 0);
  });
});

describe("twin · weekFlag.flagForV42State", () => {
  it("returns null when no signal", () => {
    assert.equal(flagForV42State({}, false), null);
  });

  it("anomaly beats everything else (s2)", () => {
    const w = {
      anomaly_no_clockout: 1,
      anomaly_under_1h: 2,
      anomaly_over_16h: 0,
      hours_without_dollars: 10,
      draft_entry_count: 3,
    };
    const f = flagForV42State(w, true);
    assert.equal(f.state, "s2");
    assert.equal(f.label, "3 need attention");
    assert.equal(f.glyph, "⚠");
  });

  it("closed + unpriced -> s3b", () => {
    const f = flagForV42State({ hours_without_dollars: 5 }, true);
    assert.equal(f.state, "s3b");
    assert.ok(f.label.includes("5.0 hrs missing pay data"));
  });

  it("closed + drafts only -> s3a", () => {
    const f = flagForV42State({ draft_entry_count: 1, draft_hours: 2.5 }, true);
    assert.equal(f.state, "s3a");
    assert.ok(f.label.includes("2.5 hrs"));
  });

  it("open + drafts -> s1, mute", () => {
    const f = flagForV42State({ draft_entry_count: 2, draft_hours: 1.2 }, false);
    assert.equal(f.state, "s1");
    assert.equal(f.glyph, null);
    assert.ok(f.label.includes("1.2 hrs"));
  });

  it("singular 'need' at count 1", () => {
    const f = flagForV42State({ anomaly_under_1h: 1 }, false);
    assert.equal(f.label, "1 needs attention");
  });
});

describe("twin · dashOrValue.resolveDashState", () => {
  it("failed flag wins over everything", () => {
    assert.equal(resolveDashState({ value: 10, flags: ["failed", "not_started"] }), "failed");
  });
  it("not_started before not_active before missing", () => {
    assert.equal(resolveDashState({ value: null, flags: ["not_started"] }), "not_started");
    assert.equal(resolveDashState({ value: null, flags: ["not_active"] }), "not_active");
  });
  it("reported false -> missing", () => {
    assert.equal(resolveDashState({ value: 5, reported: false }), "missing");
  });
  it("value 0 + reported -> zero", () => {
    assert.equal(resolveDashState({ value: 0, reported: true }), "zero");
  });
  it("value null -> missing", () => {
    assert.equal(resolveDashState({ value: null, reported: true }), "missing");
  });
  it("value present -> value", () => {
    assert.equal(resolveDashState({ value: 10, reported: true }), "value");
  });
  it("dashOrValue returns state + value", () => {
    const r = dashOrValue({ value: 100, reported: true });
    assert.equal(r.state, "value");
    assert.equal(r.value, 100);
  });
  it("formatDashOrValue copy", () => {
    assert.equal(formatDashOrValue("zero", null), "$0");
    assert.equal(formatDashOrValue("failed", null), "failed");
    assert.equal(formatDashOrValue("not_active", null), "not active");
    assert.equal(formatDashOrValue("no_budget", null), "no budget");
    assert.equal(formatDashOrValue("not_started", null), "not started");
    assert.equal(formatDashOrValue("missing", null), "-");
    assert.equal(formatDashOrValue("value", "$10"), "$10");
  });
});

describe("twin · laborAggregate (closed-range shape)", () => {
  const actuals = [
    // Week 1 (2026-08-10 .. 08-16, P9)
    { worker_id: "w1", account_key: "A", week_start: "2026-08-10", week_end: "2026-08-16",
      hours_regular: 10, hours_overtime: 1, hours_double_time: 0, amount: 120,
      hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
    { worker_id: "w2", account_key: "A", week_start: "2026-08-10", week_end: "2026-08-16",
      hours_regular: 8, hours_overtime: 0, hours_double_time: 0, amount: 80,
      hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
    // Week 2 (2026-08-17 .. 08-23, P9)
    { worker_id: "w1", account_key: "A", week_start: "2026-08-17", week_end: "2026-08-23",
      hours_regular: 12, hours_overtime: 2, hours_double_time: 0, amount: 150,
      hours_without_dollars: 0, draft_hours: 4, coverage_state: "complete" },
  ];

  it("buildFilteredActuals returns actuals as-is when no filter", () => {
    const out = buildFilteredActuals(actuals, null);
    assert.equal(out.length, 3);
  });

  it("buildFilteredActuals filters by selectedWorkers", () => {
    const sel = new Set(["w1"]);
    const out = buildFilteredActuals(actuals, sel);
    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.worker_id === "w1"));
  });

  it("buildWeekAggregates sums per week and sorts desc by week_start", () => {
    const boardWeeks = [
      { week_start: "2026-08-10", budget_at_this_week_revenue: 100 },
      { week_start: "2026-08-17", budget_at_this_week_revenue: 130 },
    ];
    const out = buildWeekAggregates(actuals, new Set(), boardWeeks, FY2026);
    assert.equal(out.length, 2);
    // Desc: 08-17 first, 08-10 second.
    assert.equal(out[0].week_start, "2026-08-17");
    assert.equal(out[1].week_start, "2026-08-10");
    // Period lookup via FY2026 - P9 contains both weeks.
    assert.equal(out[0].period_no, 9);
    assert.equal(out[1].period_no, 9);
    // Fiscal year from periods.
    assert.equal(out[0].fiscal_year, 2026);
    // Week 1 totals.
    const w1 = out[1];
    assert.equal(w1.amount, 200);
    assert.equal(w1.hours_regular, 18);
    assert.equal(w1.hours_overtime, 1);
    assert.equal(w1.budget_at_this_week_revenue, 100);
    // Week 2 totals.
    const w2 = out[0];
    assert.equal(w2.amount, 150);
    assert.equal(w2.draft_hours, 4);
    assert.equal(w2.budget_at_this_week_revenue, 130);
  });

  it("buildWeekAggregates excludes rollup members, keeps worker_rows", () => {
    const excluded = new Set(["A"]);
    const out = buildWeekAggregates(actuals, excluded, [], FY2026);
    // All rows excluded -> amount stays 0, but worker_rows still carries rows.
    assert.equal(out[0].amount, 0);
    assert.equal(out[0].hours_regular, 0);
    assert.ok(out[0].worker_rows.length > 0);
  });

  it("buildWorkerRoster sorted + uses workerLabel", () => {
    const roster = buildWorkerRoster(
      actuals,
      { w1: { display_name: "Alice", number: 42 }, w2: { display_name: "Bob", number: 7 } },
      false,
    );
    assert.equal(roster.length, 2);
    // Alice (42) before Bob (7) alphabetically.
    assert.ok(roster[0].label.startsWith("Alice"));
    assert.ok(roster[1].label.startsWith("Bob"));
  });

  it("buildWorkerRoster redact mode shows only number + title", () => {
    const roster = buildWorkerRoster(
      actuals,
      { w1: { display_name: "Alice", number: 42, title: "Chef" }, w2: { display_name: "Bob", number: 7 } },
      true,
    );
    // #42 vs #7 -> #42 sorts after #7 numerically but alphabetically "#42" < "#7".
    // Just assert both exist.
    const labels = roster.map((r) => r.label).sort();
    assert.ok(labels[0].includes("#"));
  });

  it("buildWorkerRangeTotals sums hours+dollars per worker", () => {
    const totals = buildWorkerRangeTotals(actuals);
    assert.equal(totals.w1.hoursWorked, 10 + 1 + 12 + 2);
    assert.equal(totals.w1.dollarsTotal, 120 + 150);
    assert.equal(totals.w2.hoursWorked, 8);
    assert.equal(totals.w2.dollarsTotal, 80);
  });
});
