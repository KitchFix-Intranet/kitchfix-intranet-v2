// Pure tests for the week-state resolver. Pin 8.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveWeekState } from "../../calendar/weekState.ts";

function dayWith(state) {
  const toneByState = {
    entered: "navy", part_entered: "navy", submitted: "good", closed: "muted",
    not_served: "navy", no_actuals: "muted", needs_actuals: "warn", projected: "muted",
    no_service: "muted", needs_fix: "warn",
  };
  return { iso: "2026-11-02", dow: 0, isToday: false, meals: null, projectedMeals: null, marked: false, hasBlankLine: false, home: null, state, word: state, tone: toneByState[state], icon: "minus" };
}

test("weekState: a submitted row + corp viewer + push_failed reads 'QuickBooks push failed'", () => {
  const out = resolveWeekState({
    days: Array(7).fill(dayWith("submitted")),
    isSubmitted: true,
    isPushFailed: true,
    isCorpViewer: true,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: true,
  });
  assert.equal(out.state, "push_failed");
  assert.equal(out.tone, "block");
});

test("weekState: a push_failed row + non-corp viewer reads Submitted", () => {
  const out = resolveWeekState({
    days: Array(7).fill(dayWith("submitted")),
    isSubmitted: true,
    isPushFailed: true,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: true,
  });
  assert.equal(out.state, "submitted");
  assert.equal(out.tone, "good");
});

test("weekState: no service on any day = Not serving", () => {
  const out = resolveWeekState({
    days: Array(7).fill(dayWith("no_service")),
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: true,
  });
  assert.equal(out.state, "not_serving");
});

test("weekState: all days inside a closed period, no submit = Period closed", () => {
  const out = resolveWeekState({
    days: [...Array(5).fill(dayWith("projected")), dayWith("no_service"), dayWith("no_service")],
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: true,
    unitEndedBeforeSiteToday: true,
  });
  assert.equal(out.state, "period_closed");
});

test("weekState: unit ended with no submit = Still open", () => {
  const out = resolveWeekState({
    days: [...Array(5).fill(dayWith("entered")), dayWith("projected"), dayWith("no_service")],
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: true,
  });
  assert.equal(out.state, "still_open");
  assert.equal(out.tone, "warn");
});

test("weekState: open week with days to enter carries the count in the word", () => {
  const out = resolveWeekState({
    days: [...Array(3).fill(dayWith("entered")), ...Array(2).fill(dayWith("projected")), ...Array(2).fill(dayWith("no_service"))],
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: false,
  });
  assert.equal(out.state, "to_enter");
  assert.equal(out.word, "2 days to enter");
});

test("weekState: a single day to enter reads singular", () => {
  const out = resolveWeekState({
    days: [...Array(4).fill(dayWith("entered")), dayWith("projected"), dayWith("no_service"), dayWith("no_service")],
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: false,
  });
  assert.equal(out.word, "1 day to enter");
});

test("weekState: open week, every projected line answered = Entered", () => {
  const out = resolveWeekState({
    days: [...Array(5).fill(dayWith("entered")), ...Array(2).fill(dayWith("no_service"))],
    isSubmitted: false,
    isPushFailed: false,
    isCorpViewer: false,
    isPeriodClosedForEveryDay: false,
    unitEndedBeforeSiteToday: false,
  });
  assert.equal(out.state, "entered");
});
