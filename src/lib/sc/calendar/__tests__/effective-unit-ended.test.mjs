// Fix 1 (train 4): the three surfaces consult the SAME helper so
// a never-submitted site cannot read one verb on the calendar, a
// different verb on the sites board, and a third on the week check.
//
// `effectiveUnitEndedBeforeSiteToday` is the one branch point. The
// test below pins one scenario (a never-submitted account, a unit
// that ended before today, before cutover) and asserts the same
// answer from the helper's point of view on all three surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveUnitEndedBeforeSiteToday } from "../isAskedYet.ts";
import { resolveDayState } from "../dayState.ts";
import { resolveWeekState } from "../weekState.ts";

// ── pins ──────────────────────────────────────────────────────────

const siteToday   = "2026-11-18";
const unitEndIso  = "2026-11-15";  // the Sunday before
const future      = "2026-12-28";  // cutover date (asked from here)

// ── shared helper: the one branch ─────────────────────────────────

test("the helper collapses to one answer per (today, unit, anyFinEver)", () => {
  // Never submitted + before cutover + unit ended -> NOT ended for display.
  assert.equal(
    effectiveUnitEndedBeforeSiteToday(siteToday, unitEndIso, false),
    false,
  );
  // Any finalize ever -> back to the plain date comparison.
  assert.equal(
    effectiveUnitEndedBeforeSiteToday(siteToday, unitEndIso, true),
    true,
  );
  // After cutover -> the exempt rule is off for everyone.
  assert.equal(
    effectiveUnitEndedBeforeSiteToday(future, unitEndIso, false),
    true,
  );
});

// ── three surfaces, one answer ────────────────────────────────────

test("never-submitted + unit ended + before cutover -> three surfaces agree on 'projected / to_enter'", () => {
  const anyFinalizeRowEver = false;
  const effective = effectiveUnitEndedBeforeSiteToday(
    siteToday,
    unitEndIso,
    anyFinalizeRowEver,
  );
  assert.equal(effective, false);

  // (1) Calendar's resolveDayState for a day with a projected line
  //     and nothing entered. With effective=false -> 'projected'
  //     (not 'needs_actuals').
  const day = resolveDayState({
    hasAnyActualAbove: false,
    hasAnyActualZero: false,
    hasAnyProjectedAbove: true,
    blankProjectedCount: 1,
    reviewStatus: null,
    isInSubmittedSpan: false,
    isPeriodClosed: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(day.state, "projected");

  // (2) Sites board's resolveWeekState for a week with only
  //     projected days. With effective=false -> 'to_enter'
  //     (not 'still_open').
  const days = Array.from({ length: 7 }, () => ({
    state: "projected",
  }));
  const week = resolveWeekState({
    // days is typed as DayView[]; the state is all the week-state
    // function reads from each entry's `.state`. Cast-free: the
    // function only looks at `state`.
    days,
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: true,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(week.state, "to_enter");

  // (3) Week check's resolveDayState (same function as the calendar)
  //     with the same input -> same answer.
  const review = resolveDayState({
    hasAnyActualAbove: false,
    hasAnyActualZero: false,
    hasAnyProjectedAbove: true,
    blankProjectedCount: 1,
    reviewStatus: null,
    isInSubmittedSpan: false,
    isPeriodClosed: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(review.state, day.state);
});

test("any-finalize-ever flips the same three surfaces to 'needs_actuals / still_open'", () => {
  const anyFinalizeRowEver = true;
  const effective = effectiveUnitEndedBeforeSiteToday(
    siteToday,
    unitEndIso,
    anyFinalizeRowEver,
  );
  assert.equal(effective, true);

  const day = resolveDayState({
    hasAnyActualAbove: false,
    hasAnyActualZero: false,
    hasAnyProjectedAbove: true,
    blankProjectedCount: 1,
    reviewStatus: null,
    isInSubmittedSpan: false,
    isPeriodClosed: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(day.state, "needs_actuals");

  const days = Array.from({ length: 7 }, () => ({
    state: "needs_actuals",
  }));
  const week = resolveWeekState({
    days,
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: true,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(week.state, "still_open");
});

test("after cutover: exempt is off regardless of history (three surfaces still agree)", () => {
  const anyFinalizeRowEver = false;
  const effective = effectiveUnitEndedBeforeSiteToday(
    future,
    unitEndIso,
    anyFinalizeRowEver,
  );
  assert.equal(effective, true);

  const day = resolveDayState({
    hasAnyActualAbove: false,
    hasAnyActualZero: false,
    hasAnyProjectedAbove: true,
    blankProjectedCount: 1,
    reviewStatus: null,
    isInSubmittedSpan: false,
    isPeriodClosed: false,
    unitEndedBeforeSiteToday: effective,
  });
  assert.equal(day.state, "needs_actuals");
});
