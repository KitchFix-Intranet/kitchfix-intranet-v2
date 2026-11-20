// Twin tests for the pure functions in the 12 labor/purchasing
// helpers that train 2c moved from v1 (`~/dev/kf-kpi-readonly` at
// `c3c1b90260accfebe411c2c44416065351efc378`) into V2 under
// src/lib/kpi/**.
//
// Every expected value here was captured by running v1's pure function
// at the pin with the exact same inputs (see /tmp/v1_harness.mjs the
// author used while building this test; the values below are hand-
// copied from its stdout and the harness is intentionally not shipped
// because the comparison is the test, not the capture).
//
// Each case names:
//   v1 path:  `src/lib/labor/<file>.js` or
//             `src/app/kpi/purchasing/lib/precedence.js` at the pin
//   v2 path:  `src/lib/kpi/**` in this repo
// so a maintainer can diff byte-for-byte if the test ever fails.
//
// Pure means: no `supa.*`, no `new Date()` / `Date.now()`. Every helper
// below was verified with a grep before being added (one "pure"
// candidate - homestandResolver's `listHomestands` and
// `foldPerStandSplits` - was dropped because they call supa; another
// - rangeResolver's module-level `new Date(...T00:00:00Z)` - is pure in
// practice because the constructor is deterministic for ISO strings and
// never reads the wall clock).
//
// Train 2c scope: inputs are made up. No real account dollar figure
// appears anywhere in this file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { proRateBudget } from "../labor/budgetProRate.js";
import { salaryProRate } from "../labor/salaryProRate.js";
import { dedupePaySegments } from "../labor/paySegmentDedupe.js";
import { resolveRangeSource } from "../labor/rangeResolver.js";
import {
  groupGamesIntoStands,
  perDayMilleCents,
  computeSplitWithGameDates,
  computeHomestandBank,
  actualsByStand,
} from "../labor/homestandResolver.js";
import { mergePending } from "../purchasing/precedence.js";

// ─── budgetProRate ─────────────────────────────────────────────────
// v1: src/lib/labor/budgetProRate.js
// v2: src/lib/kpi/labor/budgetProRate.ts
describe("proRateBudget (twin of v1 budgetProRate)", () => {
  it("whole week is unlabelled and sums to the week budget", () => {
    const got = proRateBudget({
      startISO: "2026-03-23", endISO: "2026-03-29",
      weekBudgets: [{ week_start: "2026-03-23", amount: 700 }],
    });
    assert.deepStrictEqual(got, {
      periods: [{
        week_start: "2026-03-23", week_end: "2026-03-29",
        days_in_week: 7, days_in_range: 7,
        week_budget: 700, budget_slice: 700,
      }],
      total: 700,
      label: null,
    });
  });

  it("partial single week carries the N-of-7 label", () => {
    const got = proRateBudget({
      startISO: "2026-03-23", endISO: "2026-03-26",
      weekBudgets: [{ week_start: "2026-03-23", amount: 700 }],
    });
    assert.deepStrictEqual(got, {
      periods: [{
        week_start: "2026-03-23", week_end: "2026-03-29",
        days_in_week: 7, days_in_range: 4,
        week_budget: 700, budget_slice: 400,
      }],
      total: 400,
      label: "pro-rated, 4 of 7 days of wk 03/23",
    });
  });

  it("multi-week partial sums both slices and labels by total days", () => {
    const got = proRateBudget({
      startISO: "2026-03-25", endISO: "2026-04-01",
      weekBudgets: [
        { week_start: "2026-03-23", amount: 700 },
        { week_start: "2026-03-30", amount: 840 },
      ],
    });
    assert.deepStrictEqual(got, {
      periods: [
        {
          week_start: "2026-03-23", week_end: "2026-03-29",
          days_in_week: 7, days_in_range: 5,
          week_budget: 700, budget_slice: 500,
        },
        {
          week_start: "2026-03-30", week_end: "2026-04-05",
          days_in_week: 7, days_in_range: 3,
          week_budget: 840, budget_slice: 360,
        },
      ],
      total: 860,
      label: "pro-rated across 8 days",
    });
  });

  it("empty weekBudgets collapses to zero / null label", () => {
    const got = proRateBudget({
      startISO: "2026-03-23", endISO: "2026-03-26",
      weekBudgets: [],
    });
    assert.deepStrictEqual(got, { periods: [], total: 0, label: null });
  });
});

// ─── salaryProRate ────────────────────────────────────────────────
// v1: src/lib/labor/salaryProRate.js
// v2: src/lib/kpi/labor/salaryProRate.ts
describe("salaryProRate (twin of v1 salaryProRate)", () => {
  it("two workers on a whole week each keep their full week amount", () => {
    const got = salaryProRate({
      startISO: "2026-03-23", endISO: "2026-03-29",
      salaryRows: [
        { worker_id: "w1", account_key: "AAA - XX", week_start: "2026-03-23", amount: 1000 },
        { worker_id: "w2", account_key: "AAA - XX", week_start: "2026-03-23", amount: 500 },
      ],
    });
    assert.deepStrictEqual(got, {
      workers: [
        { worker_id: "w1", account_key: "AAA - XX", weeks_touched: 1, days_in_range: 7, slice: 1000 },
        { worker_id: "w2", account_key: "AAA - XX", weeks_touched: 1, days_in_range: 7, slice: 500 },
      ],
      total: 1500,
      overlapped_weeks: 1,
      overlapped_days: 7,
      label: null,
    });
  });

  it("one worker across two weeks sums across both with the days label", () => {
    const got = salaryProRate({
      startISO: "2026-03-25", endISO: "2026-04-01",
      salaryRows: [
        { worker_id: "w1", account_key: "AAA - XX", week_start: "2026-03-23", amount: 1000 },
        { worker_id: "w1", account_key: "AAA - XX", week_start: "2026-03-30", amount: 1000 },
      ],
    });
    assert.deepStrictEqual(got, {
      workers: [
        { worker_id: "w1", account_key: "AAA - XX", weeks_touched: 2, days_in_range: 8, slice: 1142.86 },
      ],
      total: 1142.86,
      overlapped_weeks: 2,
      overlapped_days: 8,
      label: "pro-rated across 8 days",
    });
  });

  it("empty rows collapse to zero / null label", () => {
    const got = salaryProRate({
      startISO: "2026-03-23", endISO: "2026-03-26",
      salaryRows: [],
    });
    assert.deepStrictEqual(got, {
      workers: [],
      total: 0,
      overlapped_weeks: 0,
      overlapped_days: 0,
      label: null,
    });
  });
});

// ─── dedupePaySegments ─────────────────────────────────────────────
// v1: src/lib/labor/paySegmentDedupe.js
// v2: src/lib/kpi/labor/paySegmentDedupe.ts
describe("dedupePaySegments (twin of v1 paySegmentDedupe)", () => {
  it("drops orphans, keeps newest per external_id, passes no-ext through", () => {
    const raw = [
      { rippling_id: "r1", payload: { external_id: "e1", system_updated_at: "2026-03-01T10:00:00Z" } },
      { rippling_id: "r2", payload: { external_id: "e1", system_updated_at: "2026-03-02T10:00:00Z" } },
      { rippling_id: "r3", payload: { external_id: "e2", system_updated_at: "2026-03-01T10:00:00Z" } },
      { rippling_id: "r_orphan", payload: { external_id: "e3", system_updated_at: "2026-03-01T10:00:00Z" } },
      { rippling_id: "r_noext", payload: {} },
    ];
    const presence = new Set(["r1", "r2", "r3", "r_noext"]);
    const got = dedupePaySegments(raw, presence);
    // Order: dedup winners by external_id insertion order, then no-ext rows.
    assert.deepStrictEqual(got.segments, [
      { rippling_id: "r2", payload: { external_id: "e1", system_updated_at: "2026-03-02T10:00:00Z" } },
      { rippling_id: "r3", payload: { external_id: "e2", system_updated_at: "2026-03-01T10:00:00Z" } },
      { rippling_id: "r_noext", payload: {} },
    ]);
    assert.deepStrictEqual(got.stats, {
      raw: 5,
      liveInPresence: 4,
      orphan: 1,
      dedupDropped: 1,
      noExtId: 1,
    });
  });

  it("empty raw returns the zeros shape", () => {
    const got = dedupePaySegments([], new Set());
    assert.deepStrictEqual(got, {
      segments: [],
      stats: { raw: 0, liveInPresence: 0, orphan: 0, dedupDropped: 0, noExtId: 0 },
    });
  });
});

// ─── resolveRangeSource ───────────────────────────────────────────
// v1: src/lib/labor/rangeResolver.js
// v2: src/lib/kpi/labor/rangeResolver.ts
describe("resolveRangeSource (twin of v1 rangeResolver)", () => {
  it("whole-week range routes to weekly", () => {
    const got = resolveRangeSource({
      startISO: "2026-05-18", endISO: "2026-05-24", dailyFloorISO: "2026-04-20",
    });
    assert.deepStrictEqual(got, {
      source: "weekly", reason: "whole_weeks",
      isWholeWeeks: true, isPartialWeek: false, spanDays: 7, refused: false,
    });
  });

  it("partial week on/after the floor routes to daily", () => {
    const got = resolveRangeSource({
      startISO: "2026-05-20", endISO: "2026-05-24", dailyFloorISO: "2026-04-20",
    });
    assert.deepStrictEqual(got, {
      source: "daily", reason: "partial_week_post_floor",
      isWholeWeeks: false, isPartialWeek: true, spanDays: 5, refused: false,
    });
  });

  it("partial week starting before the floor is refused with copy", () => {
    const got = resolveRangeSource({
      startISO: "2026-03-15", endISO: "2026-03-20", dailyFloorISO: "2026-04-20",
    });
    assert.deepStrictEqual(got, {
      source: null, reason: "range_partial_before_floor",
      isWholeWeeks: false, isPartialWeek: true, spanDays: 6, refused: true,
      refusalMessage: "Daily detail starts 04/20/26. Pick a range on or after that date, or use whole weeks.",
    });
  });

  it("49-day whole-week span still routes to weekly (not refused)", () => {
    const got = resolveRangeSource({
      startISO: "2026-05-18", endISO: "2026-07-05", dailyFloorISO: "2026-04-20",
    });
    assert.deepStrictEqual(got, {
      source: "weekly", reason: "whole_weeks",
      isWholeWeeks: true, isPartialWeek: false, spanDays: 49, refused: false,
    });
  });
});

// ─── homestandResolver (pure subset) ───────────────────────────────
// v1: src/lib/labor/homestandResolver.js
// v2: src/lib/kpi/labor/homestandResolver.ts
describe("homestandResolver pure functions (twin of v1)", () => {
  it("perDayMilleCents rounds the 28-day per-day share", () => {
    assert.strictEqual(perDayMilleCents(2800), 100000);   // 28 x 100000 = 2800000 mille == 2800 cents
    assert.strictEqual(perDayMilleCents(12345), 440893);  // Math.round(12345 * 1000 / 28)
  });

  it("groupGamesIntoStands keeps one 1-day gap together, splits on a 3+ day gap", () => {
    const got = groupGamesIntoStands([
      { service_date: "2026-04-01", day_type: "GAME" },
      { service_date: "2026-04-02", day_type: "GAME" },
      { service_date: "2026-04-04", day_type: "GAME" },
      { service_date: "2026-04-05", day_type: "GAME" },
    ]);
    assert.deepStrictEqual(got, [[
      { service_date: "2026-04-01", day_type: "GAME" },
      { service_date: "2026-04-02", day_type: "GAME" },
      { service_date: "2026-04-04", day_type: "GAME" },
      { service_date: "2026-04-05", day_type: "GAME" },
    ]]);
  });

  it("groupGamesIntoStands splits on a 3-day gap", () => {
    const got = groupGamesIntoStands([
      { service_date: "2026-04-01", day_type: "GAME" },
      { service_date: "2026-04-02", day_type: "GAME" },
      { service_date: "2026-04-06", day_type: "GAME" },
      { service_date: "2026-04-07", day_type: "GAME" },
    ]);
    assert.deepStrictEqual(got, [
      [
        { service_date: "2026-04-01", day_type: "GAME" },
        { service_date: "2026-04-02", day_type: "GAME" },
      ],
      [
        { service_date: "2026-04-06", day_type: "GAME" },
        { service_date: "2026-04-07", day_type: "GAME" },
      ],
    ]);
  });

  it("groupGamesIntoStands on empty returns empty", () => {
    assert.deepStrictEqual(groupGamesIntoStands([]), []);
  });

  it("computeSplitWithGameDates splits game vs off, counts prep + spent-to-date", () => {
    const stand = {
      pre_floor: false,
      game_start: "2026-05-18",
      game_end: "2026-05-21",
      window_start: "2026-05-17",
      window_end: "2026-05-21",
    };
    const gameDates = new Set(["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21"]);
    const actuals = [
      { work_date: "2026-05-17", amount: 100 },  // prep day (off)
      { work_date: "2026-05-18", amount: 500 },
      { work_date: "2026-05-19", amount: 500 },
      { work_date: "2026-05-20", amount: 600 },
      { work_date: "2026-05-21", amount: 400 },
    ];
    const got = computeSplitWithGameDates(actuals, stand, gameDates, "2026-05-20");
    assert.deepStrictEqual(got, {
      game_day_dollars: 2000,
      off_day_dollars: 100,
      off_day_count: 1,
      prep_day_dollars: 100,
      spent_to_date: 1700,
    });
  });

  it("computeSplitWithGameDates returns null on a pre-floor stand", () => {
    const got = computeSplitWithGameDates(
      [{ work_date: "2026-05-18", amount: 500 }],
      { pre_floor: true, game_start: "x", game_end: "y", window_start: "x", window_end: "y" },
      new Set(["2026-05-18"]),
      "2026-05-20",
    );
    assert.strictEqual(got, null);
  });

  it("actualsByStand rolls up myriadths per stand", () => {
    const stands = [
      { game_start: "2026-05-18", window_start: "2026-05-17", window_end: "2026-05-21", pre_floor: false },
      { game_start: "2026-05-25", window_start: "2026-05-24", window_end: "2026-05-27", pre_floor: false },
    ];
    const daily = [
      { work_date: "2026-05-17", amount: 100 },
      { work_date: "2026-05-18", amount: 500 },
      { work_date: "2026-05-25", amount: 300 },
      { work_date: "2026-05-27", amount: 200 },
    ];
    const got = actualsByStand(stands, daily);
    assert.deepStrictEqual([...got.entries()], [
      ["2026-05-18", 6000000],
      ["2026-05-25", 5000000],
    ]);
  });

  it("computeHomestandBank sums finished stands, splits bank by remaining", () => {
    const stands = [
      { game_start: "2026-04-01", game_end: "2026-04-05", budget: 2000, pre_floor: false },
      { game_start: "2026-05-01", game_end: "2026-05-05", budget: 2500, pre_floor: false },
      { game_start: "2026-07-01", game_end: "2026-07-05", budget: 3000, pre_floor: false },
      { game_start: "2026-08-01", game_end: "2026-08-05", budget: 3500, pre_floor: false },
      { game_start: "2026-03-01", game_end: "2026-03-05", budget: 1000, pre_floor: true },
    ];
    const acts = new Map([
      ["2026-04-01", 1900 * 10000],
      ["2026-05-01", 2300 * 10000],
    ]);
    const got = computeHomestandBank(stands, acts, "2026-06-01");
    assert.deepStrictEqual(got, {
      budget_to_date: 4500,
      spent_to_date: 4200,
      bank: 300,
      stands_finished: 2,
      stands_remaining: 2,
      remaining_budget: 6500,
      bank_share: 150,
    });
  });
});

// ─── mergePending ─────────────────────────────────────────────────
// v1: src/app/kpi/purchasing/lib/precedence.js
// v2: src/lib/kpi/purchasing/precedence.ts
describe("mergePending (twin of v1 precedence.mergePending)", () => {
  it("merges API + report-only into the board shape", () => {
    const got = mergePending(
      { amount: 123.45, line_count: 5 },
      { amount: 67.89, line_count: 2, by_account: { "AAA - XX": 67.89 },
        max_purchased_at: "2026-05-01T10:00:00Z", unavailable: false },
    );
    assert.deepStrictEqual(got, {
      amount: 191.34,
      line_count: 7,
      api: { amount: 123.45, line_count: 5 },
      report_only: {
        amount: 67.89,
        line_count: 2,
        by_account: { "AAA - XX": 67.89 },
        max_purchased_at: "2026-05-01T10:00:00Z",
        unavailable: false,
        unavailable_reason: null,
      },
    });
  });

  it("surfaces an unavailable reason when the report side times out", () => {
    const got = mergePending(
      { amount: 100, line_count: 3 },
      { amount: 0, line_count: 0, by_account: {}, max_purchased_at: null,
        unavailable: true, unavailable_reason: "timeout" },
    );
    assert.deepStrictEqual(got, {
      amount: 100,
      line_count: 3,
      api: { amount: 100, line_count: 3 },
      report_only: {
        amount: 0,
        line_count: 0,
        by_account: {},
        max_purchased_at: null,
        unavailable: true,
        unavailable_reason: "timeout",
      },
    });
  });

  it("both nulls collapse to zero shape with empty defaults", () => {
    const got = mergePending(null, null);
    assert.deepStrictEqual(got, {
      amount: 0,
      line_count: 0,
      api: { amount: 0, line_count: 0 },
      report_only: {
        amount: 0,
        line_count: 0,
        by_account: {},
        max_purchased_at: null,
        unavailable: false,
        unavailable_reason: null,
      },
    });
  });
});
