// Pure tests for the day-state resolver. Pin 7, first-match-wins.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveDayState } from "../../calendar/dayState.ts";

const BASE = {
  hasAnyActualAbove: false,
  hasAnyActualZero: false,
  hasAnyProjectedAbove: false,
  blankProjectedCount: 0,
  reviewStatus: null,
  isInSubmittedSpan: false,
  isPeriodClosed: false,
  unitEndedBeforeSiteToday: false,
};

test("dayState: needs_fix wins over everything else", () => {
  const out = resolveDayState({ ...BASE, reviewStatus: "flagged", hasAnyActualAbove: true, isInSubmittedSpan: true });
  assert.equal(out.state, "needs_fix");
  assert.equal(out.tone, "warn");
});

test("dayState: entered day in a submitted span reads Submitted", () => {
  const out = resolveDayState({ ...BASE, hasAnyActualAbove: true, isInSubmittedSpan: true });
  assert.equal(out.state, "submitted");
  assert.equal(out.tone, "good");
  assert.equal(out.icon, "lock");
});

test("dayState: entered day in a closed period reads Closed", () => {
  const out = resolveDayState({ ...BASE, hasAnyActualAbove: true, isPeriodClosed: true });
  assert.equal(out.state, "closed");
  assert.equal(out.tone, "muted");
});

test("dayState: every projected line answered = Entered", () => {
  const out = resolveDayState({ ...BASE, hasAnyActualAbove: true });
  assert.equal(out.state, "entered");
  assert.equal(out.tone, "navy");
});

test("dayState: an answered day with one blank projected line = Part entered", () => {
  const out = resolveDayState({ ...BASE, hasAnyActualAbove: true, blankProjectedCount: 1 });
  assert.equal(out.state, "part_entered");
});

test("dayState: all projected lines answered with 0 = Not served", () => {
  const out = resolveDayState({ ...BASE, hasAnyActualZero: true, hasAnyProjectedAbove: true });
  assert.equal(out.state, "not_served");
});

test("dayState: projected under a submitted span = No actuals", () => {
  const out = resolveDayState({ ...BASE, hasAnyProjectedAbove: true, isInSubmittedSpan: true });
  assert.equal(out.state, "no_actuals");
});

test("dayState: projected in a closed period = No actuals", () => {
  const out = resolveDayState({ ...BASE, hasAnyProjectedAbove: true, isPeriodClosed: true });
  assert.equal(out.state, "no_actuals");
});

test("dayState: projected and unit ended = Needs actuals", () => {
  const out = resolveDayState({ ...BASE, hasAnyProjectedAbove: true, unitEndedBeforeSiteToday: true });
  assert.equal(out.state, "needs_actuals");
  assert.equal(out.tone, "warn");
});

test("dayState: projected and unit still open = Projected", () => {
  const out = resolveDayState({ ...BASE, hasAnyProjectedAbove: true });
  assert.equal(out.state, "projected");
});

test("dayState: nothing on record = No service", () => {
  const out = resolveDayState(BASE);
  assert.equal(out.state, "no_service");
});
