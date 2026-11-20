// FinishOverlay SR line. Chat ruling 2026-11-20:
//   Weekly:   "Submitted Monday, Nov 23 at 9:35 AM. Week of Nov 16 - Nov 22."
//   Biweekly: "Submitted Monday, Nov 23 at 7:35 AM. Two weeks of Nov 9 - Nov 22."
// No year, no zone letters, no "Unit span".

import { test } from "node:test";
import assert from "node:assert/strict";
import { finishOverlaySr } from "../finishOverlaySr.ts";

test("weekly in America/New_York (EST)", () => {
  const got = finishOverlaySr({
    submittedAtIso: "2026-11-23T14:35:12.432Z",   // 09:35 EST
    unitStartIso:   "2026-11-16",
    unitEndIso:     "2026-11-22",
    timeZone:       "America/New_York",
    isPair: false,
  });
  assert.equal(got, "Submitted Monday, Nov 23 at 9:35 AM. Week of Nov 16 - Nov 22.");
});

test("biweekly in America/Phoenix (MST, year-round)", () => {
  const got = finishOverlaySr({
    submittedAtIso: "2026-11-23T14:35:12.432Z",   // 07:35 MST
    unitStartIso:   "2026-11-09",
    unitEndIso:     "2026-11-22",
    timeZone:       "America/Phoenix",
    isPair: true,
  });
  assert.equal(got, "Submitted Monday, Nov 23 at 7:35 AM. Two weeks of Nov 9 - Nov 22.");
});

test("no year appears anywhere", () => {
  const got = finishOverlaySr({
    submittedAtIso: "2026-11-23T14:35:12.432Z",
    unitStartIso:   "2026-11-16",
    unitEndIso:     "2026-11-22",
    timeZone:       "America/Chicago",
    isPair: false,
  });
  assert.doesNotMatch(got, /\b2026\b/);
  assert.doesNotMatch(got, /\b2025\b/);
});

test("no zone letters appear", () => {
  const got = finishOverlaySr({
    submittedAtIso: "2026-11-23T14:35:12.432Z",
    unitStartIso:   "2026-11-16",
    unitEndIso:     "2026-11-22",
    timeZone:       "America/New_York",
    isPair: false,
  });
  assert.doesNotMatch(got, /\bEST\b|\bEDT\b|\bCST\b|\bCDT\b|\bMST\b|\bMDT\b/);
});

test("no 'Unit span' in the line", () => {
  const got = finishOverlaySr({
    submittedAtIso: "2026-11-23T14:35:12.432Z",
    unitStartIso:   "2026-11-16",
    unitEndIso:     "2026-11-22",
    timeZone:       "America/Chicago",
    isPair: false,
  });
  assert.doesNotMatch(got, /Unit span/i);
});
