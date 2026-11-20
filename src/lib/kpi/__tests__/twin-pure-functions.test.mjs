// Twin tests for the pure-function files in the KPI engine. Each
// expected value was captured from v1's own function at the pin by
// running `src/lib/kpi/proof/_capture_v1_expected.mjs` against v1's
// worktree, and loaded here as a frozen JSON fixture.
//
// Every input is made-up; every output is "what v1 returned for that
// input." A regression here means v2 drifted from v1 behaviour on a
// file that is supposed to be a byte-for-byte move (modulo type
// syntax). Reading these tests tells you what the function does
// today - assertions, not reasoning.
//
// Train 2b: every period function now takes the fiscal year as its
// LAST argument. The test rebuilds a FY2026 object identical to what
// v1's periods.js carried in constants, so in-year calls match v1
// cent-for-cent. Out-of-year expectations may differ (v1's typed-in
// arithmetic gives odd answers past FY_END); any such change is
// listed below and in docs/KPI.md.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  periodOf,
  periodStartISO,
  periodEndISO,
  currentPeriodNo,
  r93FytdEndISO,
  r93ExcludedPeriodNo,
  periodPickerState,
  weekOfPeriod,
  rangeForPeriod,
  rangeForFiscalMonth,
  rangeForCalendarMonth,
  inferRangeSelection,
  spanLabelForRange,
  weekStartsInRange,
  fiscalYearOf,
  endOfLastCompleteWeek,
} from "../labor/periods.js";
import { snapRange, periodContainingDate } from "../rangeSnap.js";
import {
  resolvePreviewAccess,
  deriveClientAccount,
  shouldRestoreLastAccount,
  shouldAutoEnableSalary,
  shouldRenderLandingBridgeLoading,
} from "../previewAccess.js";
import { canViewAccount, canSeeSalary, landingAccount } from "../roleGate.js";
import { canonicalSubLine, isDescendantOfLine, sumRollupByLine } from "../purchasing/glRollup.js";
import {
  formatMoneyWhole,
  formatDayLabel,
  fmtWeekRange,
  formatPct,
  pctOf,
  gapDollarsCost,
  gapDollarsRevenue,
  gapDollarsMargin,
  gapPointsCost,
  gapPointsRevenue,
  gapPointsMargin,
  directionOfDelta,
} from "../overview/formatting.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

const fixturePath = path.join(path.dirname(new URL(import.meta.url).pathname), "_v1_expected.json");
const EXPECTED = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

// FY2026, byte-identical to the fiscal_periods table on 2026-11-17.
// Also byte-identical to v1's periodStartISO(1..13) / periodEndISO(1..13).
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

// Expectations that changed from v1 under train 2b. Each entry names
// the function, the input (always a date outside FY2026, verified
// below), and the new return. v1's typed-in arithmetic assigned a
// non-null period / fiscal-year to some dates outside FY2026; the
// table-driven engine returns null for dates its fiscal_periods object
// does not cover. Documented in docs/KPI.md as train 2b changes.
//
// Every input listed here is asserted against FY2026's bounds before
// the test runs; an input that slips inside the year would be a bug
// in this list.
const EXPECTATION_CHANGES = {
  periodOf: new Map(),       // input ISO -> v2 value
  fiscalYearOf: new Map(),
  weekOfPeriod: new Map(),
  periodPickerState: new Map(), // key: JSON.stringify([periodNo, todayISO])
  r93FytdEndISO: new Map(),
  r93ExcludedPeriodNo: new Map(),
  // v1 extrapolated "period 14" into a 28-day block one period past
  // FY_END by adding (14-1) x 28 days to a typed-in start; the
  // table-driven engine refuses a period_no outside [1,13] and
  // returns null. Same idea for periodStartISO(14) / periodEndISO(14)
  // if the fixture covers those.
  rangeForPeriod: new Map([
    [14, null],
  ]),
  periodStartISO: new Map(),
  periodEndISO: new Map(),
};

function isInYear(iso) {
  return typeof iso === "string" && iso >= FY2026.startISO && iso <= FY2026.endISO;
}

function patch(table, newValueByInput) {
  if (!newValueByInput || newValueByInput.size === 0) return table;
  return table.map(([input, expected]) => {
    const key = typeof input === "string" ? input : (typeof input === "number" ? input : JSON.stringify(input));
    if (newValueByInput.has(key)) {
      if (typeof input === "string") {
        if (isInYear(input)) {
          throw new Error(`EXPECTATION_CHANGES: input ${input} must be outside FY2026`);
        }
      }
      if (typeof input === "number") {
        if (input >= 1 && input <= 13) {
          throw new Error(`EXPECTATION_CHANGES: period_no ${input} is inside the fiscal year`);
        }
      }
      return [input, newValueByInput.get(key)];
    }
    return [input, expected];
  });
}

function runTable(label, fn, rows, argPacker) {
  for (const [input, expected] of rows) {
    test(`${label} ${JSON.stringify(input)}`, () => {
      const got = argPacker ? fn(...argPacker(input)) : fn(input);
      assert.deepStrictEqual(got, expected);
    });
  }
}

// ---- periods ----
// Every period function is now fy-parameterised. Wrap the fixture's
// single-arg callers with a lambda that appends FY2026; array-arg
// callers get FY2026 pushed onto the argPacker output.
runTable(
  "periodOf",
  (iso) => periodOf(iso, FY2026),
  patch(EXPECTED.periods.periodOf, EXPECTATION_CHANGES.periodOf),
);
runTable("periodStartISO", (p) => periodStartISO(p, FY2026), EXPECTED.periods.periodStartISO);
runTable("periodEndISO", (p) => periodEndISO(p, FY2026), EXPECTED.periods.periodEndISO);
runTable("currentPeriodNo", (iso) => currentPeriodNo(iso, FY2026), EXPECTED.periods.currentPeriodNo);
runTable(
  "r93FytdEndISO",
  (iso) => r93FytdEndISO(iso, FY2026),
  patch(EXPECTED.periods.r93FytdEndISO, EXPECTATION_CHANGES.r93FytdEndISO),
);
runTable(
  "r93ExcludedPeriodNo",
  (iso) => r93ExcludedPeriodNo(iso, FY2026),
  patch(EXPECTED.periods.r93ExcludedPeriodNo, EXPECTATION_CHANGES.r93ExcludedPeriodNo),
);
runTable(
  "periodPickerState",
  periodPickerState,
  EXPECTED.periods.periodPickerState,
  (x) => [...x, FY2026],
);
runTable(
  "weekOfPeriod",
  (iso) => weekOfPeriod(iso, FY2026),
  patch(EXPECTED.periods.weekOfPeriod, EXPECTATION_CHANGES.weekOfPeriod),
);
runTable(
  "rangeForPeriod",
  (p) => rangeForPeriod(p, FY2026),
  patch(EXPECTED.periods.rangeForPeriod, EXPECTATION_CHANGES.rangeForPeriod),
);
runTable("rangeForFiscalMonth", rangeForFiscalMonth, EXPECTED.periods.rangeForFiscalMonth, (x) => [...x, FY2026]);
runTable("rangeForCalendarMonth", rangeForCalendarMonth, EXPECTED.periods.rangeForCalendarMonth, (x) => [...x, FY2026]);
runTable("inferRangeSelection", inferRangeSelection, EXPECTED.periods.inferRangeSelection, (x) => [...x, FY2026]);
runTable("spanLabelForRange", spanLabelForRange, EXPECTED.periods.spanLabelForRange, (x) => [...x, FY2026]);
runTable("weekStartsInRange", weekStartsInRange, EXPECTED.periods.weekStartsInRange, (x) => [...x, FY2026]);
runTable(
  "fiscalYearOf",
  (iso) => fiscalYearOf(iso, FY2026),
  patch(EXPECTED.periods.fiscalYearOf, EXPECTATION_CHANGES.fiscalYearOf),
);
runTable("endOfLastCompleteWeek", endOfLastCompleteWeek, EXPECTED.periods.endOfLastCompleteWeek, (x) => [...x, FY2026]);

// ---- rangeSnap ----
runTable("periodContainingDate", (iso) => periodContainingDate(iso, FY2026), EXPECTED.rangeSnap.periodContainingDate);
runTable("snapRange", snapRange, EXPECTED.rangeSnap.snapRange, (x) => [...x, FY2026]);

// ---- previewAccess ----
// resolvePreviewAccess takes canViewAccount from an outer closure;
// use the one from roleGate.ts.
for (const [args, expected] of EXPECTED.previewAccess.resolvePreviewAccess) {
  test(`resolvePreviewAccess ${JSON.stringify({ urlAccount: args.urlAccount, previewParam: args.previewParam, callerRole: args.caller?.role })}`, () => {
    const got = resolvePreviewAccess({
      caller: args.caller,
      canViewAccount,
      urlAccount: args.urlAccount,
      previewParam: args.previewParam,
    });
    assert.deepStrictEqual(got, expected);
  });
}
runTable("deriveClientAccount", deriveClientAccount, EXPECTED.previewAccess.deriveClientAccount);
runTable("shouldRestoreLastAccount", shouldRestoreLastAccount, EXPECTED.previewAccess.shouldRestoreLastAccount);
runTable("shouldAutoEnableSalary", shouldAutoEnableSalary, EXPECTED.previewAccess.shouldAutoEnableSalary);
runTable("shouldRenderLandingBridgeLoading", shouldRenderLandingBridgeLoading, EXPECTED.previewAccess.shouldRenderLandingBridgeLoading);

// ---- roleGate three access rules ----
runTable("canViewAccount", canViewAccount, EXPECTED.roleGate.canViewAccount, (x) => x);
runTable("canSeeSalary", canSeeSalary, EXPECTED.roleGate.canSeeSalary, (x) => x);
runTable("landingAccount", landingAccount, EXPECTED.roleGate.landingAccount);

// ---- glRollup ----
runTable("canonicalSubLine", canonicalSubLine, EXPECTED.glRollup.canonicalSubLine);
runTable("isDescendantOfLine", isDescendantOfLine, EXPECTED.glRollup.isDescendantOfLine, (x) => x);
for (const [input, expected] of EXPECTED.glRollup.sumRollupByLine) {
  const [rows, line] = input;
  test(`sumRollupByLine ${line}`, () => {
    const got = sumRollupByLine({ rows, line, getCode: r => r.gl, getAmount: r => r.amt });
    assert.strictEqual(got, expected);
  });
}

// ---- formatting ----
runTable("formatMoneyWhole", formatMoneyWhole, EXPECTED.formatting.formatMoneyWhole);
runTable("formatDayLabel", formatDayLabel, EXPECTED.formatting.formatDayLabel);
runTable("fmtWeekRange", fmtWeekRange, EXPECTED.formatting.fmtWeekRange, (x) => x);
runTable("formatPct", formatPct, EXPECTED.formatting.formatPct);
runTable("pctOf", pctOf, EXPECTED.formatting.pctOf, (x) => x);
runTable("gapDollarsCost", gapDollarsCost, EXPECTED.formatting.gapDollarsCost);
runTable("gapDollarsRevenue", gapDollarsRevenue, EXPECTED.formatting.gapDollarsRevenue);
runTable("gapDollarsMargin", gapDollarsMargin, EXPECTED.formatting.gapDollarsMargin);
runTable("gapPointsCost", gapPointsCost, EXPECTED.formatting.gapPointsCost);
runTable("gapPointsRevenue", gapPointsRevenue, EXPECTED.formatting.gapPointsRevenue);
runTable("gapPointsMargin", gapPointsMargin, EXPECTED.formatting.gapPointsMargin);
runTable("directionOfDelta", directionOfDelta, EXPECTED.formatting.directionOfDelta, (x) => x);
