// Train 2b: the fiscal year is an input, not a typed-in constant.
//
// These tests exercise the period functions on a made-up fiscal year
// 2027 (byte-identical shape to v1's FY2026 but anchored at a new
// start) and verify that two different years resolved at the same
// moment never contaminate each other's answers.
//
// Every input here is made up. Dates outside a fiscal year resolve to
// null - the documented train 2b behaviour change; this file is the
// contract for it.

import test from "node:test";
import assert from "node:assert/strict";
import {
  periodOf,
  periodStartISO,
  periodEndISO,
  weekStartsInRange,
  fiscalYearOf,
  endOfLastCompleteWeek,
} from "../labor/periods.js";
import { snapRange } from "../rangeSnap.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

// Made-up 2026 beside a made-up 2027. The 2026 shape matches the
// real fiscal_periods table; the 2027 shape is built fresh with its
// own start day (a Monday one day after 2026's end).
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

// Fiscal 2027 made up: starts the day after FY2026 ends, 28-day
// periods back to back, same 13-period shape.
const FY2027 = buildFiscalYear(2027, [
  { period_no: 1,  start_date: "2026-12-28", end_date: "2027-01-24" },
  { period_no: 2,  start_date: "2027-01-25", end_date: "2027-02-21" },
  { period_no: 3,  start_date: "2027-02-22", end_date: "2027-03-21" },
  { period_no: 4,  start_date: "2027-03-22", end_date: "2027-04-18" },
  { period_no: 5,  start_date: "2027-04-19", end_date: "2027-05-16" },
  { period_no: 6,  start_date: "2027-05-17", end_date: "2027-06-13" },
  { period_no: 7,  start_date: "2027-06-14", end_date: "2027-07-11" },
  { period_no: 8,  start_date: "2027-07-12", end_date: "2027-08-08" },
  { period_no: 9,  start_date: "2027-08-09", end_date: "2027-09-05" },
  { period_no: 10, start_date: "2027-09-06", end_date: "2027-10-03" },
  { period_no: 11, start_date: "2027-10-04", end_date: "2027-10-31" },
  { period_no: 12, start_date: "2027-11-01", end_date: "2027-11-28" },
  { period_no: 13, start_date: "2027-11-29", end_date: "2027-12-26" },
]);

test("loader rejects a year with the wrong period count", () => {
  assert.throws(() => buildFiscalYear(2026, [
    { period_no: 1, start_date: "2025-12-29", end_date: "2026-01-25" },
  ]), /must have exactly 13 rows/);
});

test("loader rejects a period that is not 28 days", () => {
  assert.throws(() => buildFiscalYear(2026, [
    { period_no: 1,  start_date: "2025-12-29", end_date: "2026-01-26" }, // 29 days
    { period_no: 2,  start_date: "2026-01-27", end_date: "2026-02-23" },
    { period_no: 3,  start_date: "2026-02-24", end_date: "2026-03-23" },
    { period_no: 4,  start_date: "2026-03-24", end_date: "2026-04-20" },
    { period_no: 5,  start_date: "2026-04-21", end_date: "2026-05-18" },
    { period_no: 6,  start_date: "2026-05-19", end_date: "2026-06-15" },
    { period_no: 7,  start_date: "2026-06-16", end_date: "2026-07-13" },
    { period_no: 8,  start_date: "2026-07-14", end_date: "2026-08-10" },
    { period_no: 9,  start_date: "2026-08-11", end_date: "2026-09-07" },
    { period_no: 10, start_date: "2026-09-08", end_date: "2026-10-05" },
    { period_no: 11, start_date: "2026-10-06", end_date: "2026-11-02" },
    { period_no: 12, start_date: "2026-11-03", end_date: "2026-11-30" },
    { period_no: 13, start_date: "2026-12-01", end_date: "2026-12-28" },
  ]), /is 29 days, expected 28/);
});

test("loader rejects periods that are not back-to-back", () => {
  assert.throws(() => buildFiscalYear(2026, [
    { period_no: 1,  start_date: "2025-12-29", end_date: "2026-01-25" },
    { period_no: 2,  start_date: "2026-01-27", end_date: "2026-02-23" }, // one-day gap
    { period_no: 3,  start_date: "2026-02-24", end_date: "2026-03-23" },
    { period_no: 4,  start_date: "2026-03-24", end_date: "2026-04-20" },
    { period_no: 5,  start_date: "2026-04-21", end_date: "2026-05-18" },
    { period_no: 6,  start_date: "2026-05-19", end_date: "2026-06-15" },
    { period_no: 7,  start_date: "2026-06-16", end_date: "2026-07-13" },
    { period_no: 8,  start_date: "2026-07-14", end_date: "2026-08-10" },
    { period_no: 9,  start_date: "2026-08-11", end_date: "2026-09-07" },
    { period_no: 10, start_date: "2026-09-08", end_date: "2026-10-05" },
    { period_no: 11, start_date: "2026-10-06", end_date: "2026-11-02" },
    { period_no: 12, start_date: "2026-11-03", end_date: "2026-11-30" },
    { period_no: 13, start_date: "2026-12-01", end_date: "2026-12-28" },
  ]), /not back-to-back/);
});

test("FY2027 period bounds read from the object", () => {
  assert.equal(periodStartISO(1, FY2027), "2026-12-28");
  assert.equal(periodEndISO(1, FY2027), "2027-01-24");
  assert.equal(periodStartISO(13, FY2027), "2027-11-29");
  assert.equal(periodEndISO(13, FY2027), "2027-12-26");
});

test("periodOf against two years at once", () => {
  // Same calendar date 2026-07-15 is P8 in FY2026, outside FY2027.
  assert.equal(periodOf("2026-07-15", FY2026), 8);
  assert.equal(periodOf("2026-07-15", FY2027), null);
  // Same calendar date 2027-07-15 is outside FY2026, P8 in FY2027.
  assert.equal(periodOf("2027-07-15", FY2026), null);
  assert.equal(periodOf("2027-07-15", FY2027), 8);
});

test("date outside the fiscal year returns null, not a neighbouring period", () => {
  // 2027-01-15 falls inside FY2027 P1 but outside FY2026; FY2026's
  // bound is 2026-12-27. Train 2b change (documented in docs/KPI.md):
  // v1's arithmetic returned a non-null "period 14" extrapolation.
  assert.equal(periodOf("2027-01-15", FY2026), null);
  assert.equal(periodOf("2027-01-15", FY2027), 1);
});

test("first and last day of the year read from the object", () => {
  assert.equal(FY2026.startISO, "2025-12-29");
  assert.equal(FY2026.endISO, "2026-12-27");
  assert.equal(FY2027.startISO, "2026-12-28");
  assert.equal(FY2027.endISO, "2027-12-26");
});

test("fiscalYearOf in-range returns fy.year", () => {
  assert.equal(fiscalYearOf("2026-07-15", FY2026), 2026);
  assert.equal(fiscalYearOf("2027-07-15", FY2027), 2027);
});

test("weekStartsInRange is a pure function of fy + range", () => {
  // Three complete weeks starting at 2026-07-06 land inside FY2026.
  const weeks = weekStartsInRange("2026-07-06", "2026-07-26", FY2026);
  assert.deepEqual(weeks, ["2026-07-06", "2026-07-13", "2026-07-20"]);
  // Same range against FY2027 returns nothing (range is entirely
  // outside the FY2027 window).
  assert.deepEqual(weekStartsInRange("2026-07-06", "2026-07-26", FY2027), []);
});

test("snapRange refuses to guess a year - FYTD maps to fy.startISO", () => {
  const snap26 = snapRange("", "", "2026-11-17", FY2026);
  assert.equal(snap26.start, "2025-12-29");
  const snap27 = snapRange("", "", "2027-06-01", FY2027);
  assert.equal(snap27.start, "2026-12-28");
});

test("endOfLastCompleteWeek picks the right year", () => {
  // In FY2026 on 2026-11-17 (Tuesday of week 3 of P12), last complete
  // week ends 2026-11-15.
  const r26 = endOfLastCompleteWeek(FY2026.startISO, "2026-11-17", "2026-11-17", FY2026);
  assert.equal(r26.effectiveEndISO, "2026-11-15");
  // Same calendar date against FY2027's range yields nothing (date
  // predates FY2027).
  const r27 = endOfLastCompleteWeek(FY2027.startISO, FY2027.endISO, "2026-11-17", FY2027);
  assert.equal(r27, null);
});

test("two fiscal years resolved interleaved never contaminate each other", async () => {
  // Start twenty parallel resolutions, alternating years, and confirm
  // every one gets the right answer. A shared module-level variable
  // would show up as cross-talk; this test is the fence.
  const tasks = [];
  for (let i = 0; i < 20; i += 1) {
    const fy = i % 2 === 0 ? FY2026 : FY2027;
    const date = i % 2 === 0 ? "2026-07-15" : "2027-07-15";
    const expected = 8;
    tasks.push((async () => {
      const got = periodOf(date, fy);
      await new Promise((r) => setImmediate(r));
      assert.equal(got, expected, `iteration ${i}: ${date} in FY${fy.year}`);
    })());
  }
  await Promise.all(tasks);
});
