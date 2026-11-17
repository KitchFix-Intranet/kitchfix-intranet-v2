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

const fixturePath = path.join(path.dirname(new URL(import.meta.url).pathname), "_v1_expected.json");
const EXPECTED = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function runTable(label, fn, rows, argPacker) {
  for (const [input, expected] of rows) {
    test(`${label} ${JSON.stringify(input)}`, () => {
      const got = argPacker ? fn(...argPacker(input)) : fn(input);
      assert.deepStrictEqual(got, expected);
    });
  }
}

// ---- periods ----
runTable("periodOf", periodOf, EXPECTED.periods.periodOf);
runTable("periodStartISO", periodStartISO, EXPECTED.periods.periodStartISO);
runTable("periodEndISO", periodEndISO, EXPECTED.periods.periodEndISO);
runTable("currentPeriodNo", currentPeriodNo, EXPECTED.periods.currentPeriodNo);
runTable("r93FytdEndISO", r93FytdEndISO, EXPECTED.periods.r93FytdEndISO);
runTable("r93ExcludedPeriodNo", r93ExcludedPeriodNo, EXPECTED.periods.r93ExcludedPeriodNo);
runTable("periodPickerState", periodPickerState, EXPECTED.periods.periodPickerState, (x) => x);
runTable("weekOfPeriod", weekOfPeriod, EXPECTED.periods.weekOfPeriod);
runTable("rangeForPeriod", rangeForPeriod, EXPECTED.periods.rangeForPeriod);
runTable("rangeForFiscalMonth", rangeForFiscalMonth, EXPECTED.periods.rangeForFiscalMonth, (x) => x);
runTable("rangeForCalendarMonth", rangeForCalendarMonth, EXPECTED.periods.rangeForCalendarMonth, (x) => x);
runTable("inferRangeSelection", inferRangeSelection, EXPECTED.periods.inferRangeSelection, (x) => x);
runTable("spanLabelForRange", spanLabelForRange, EXPECTED.periods.spanLabelForRange, (x) => x);
runTable("weekStartsInRange", weekStartsInRange, EXPECTED.periods.weekStartsInRange, (x) => x);
runTable("fiscalYearOf", fiscalYearOf, EXPECTED.periods.fiscalYearOf);
runTable("endOfLastCompleteWeek", endOfLastCompleteWeek, EXPECTED.periods.endOfLastCompleteWeek, (x) => x);

// ---- rangeSnap ----
runTable("periodContainingDate", periodContainingDate, EXPECTED.rangeSnap.periodContainingDate);
runTable("snapRange", snapRange, EXPECTED.rangeSnap.snapRange, (x) => x);

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
