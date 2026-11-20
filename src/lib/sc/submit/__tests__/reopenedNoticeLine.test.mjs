// Train 5 fix 5 (2026-11-20): the "open again" line is built from
// the server's unit span, not inferred from the loaded weeks. Both
// variants proven here (weekly W3 of a four-week period, and a
// biweekly pair).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReopenedNoticeLine } from "../reopenedNoticeLine.ts";

test("weekly reopen of the third week of a period -> 'Week of …'", () => {
  // Invented dates. Weekly site: the server returns the same Monday
  // as unitSpanStart + that Sunday as unitSpanEnd; isPair false.
  // fmtDate("short") renders a date-only ISO as "<Mon> <D>" or
  // "<Mon> <D>, <YEAR>" depending on current year; assert the shape
  // rather than the exact string so this test is not time-fragile.
  const line = buildReopenedNoticeLine({
    startIso: "2026-11-16",
    endIso:   "2026-11-22",
    isPair:   false,
  });
  assert.match(line, /^Week of Nov 16(, 2026)? - Nov 22(, 2026)? is open again\.$/);
});

test("biweekly closing-week reopen -> 'The two weeks of …'", () => {
  // Biweekly pair of Nov 2 - Nov 15, reopened from the closing
  // Monday (Nov 9). The server's unit span is the pair's two Mondays
  // through the pair's closing Sunday. isPair true.
  const line = buildReopenedNoticeLine({
    startIso: "2026-11-02",
    endIso:   "2026-11-15",
    isPair:   true,
  });
  assert.match(line, /^The two weeks of /);
  assert.match(line, / are open again\.$/);
});

test("the pair phrase is never produced from a weekly input, regardless of span", () => {
  // Even if a bad caller passes a 14-day span with isPair=false
  // (should not happen; the server sets both), the component says
  // "Week of" because the flag is false. This pins the server's
  // flag as the source of truth, not the date math.
  const line = buildReopenedNoticeLine({
    startIso: "2026-11-02",
    endIso:   "2026-11-15",
    isPair:   false,
  });
  assert.match(line, /^Week of /);
});
