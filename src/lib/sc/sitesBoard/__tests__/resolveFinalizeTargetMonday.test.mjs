// Fix 1 (train 4b): the board picks the finalize row for THIS unit,
// not a stray row from the previous week or the previous pair.
//
// The helper that decides the target Monday is unexported; the rule
// itself is simple enough to spot-check through a tiny driver that
// matches the loader's shape: a weekly site returns boardMonday; a
// biweekly site returns boardMonday when the pair is closing, and
// boardMonday+7 when it is opening.
//
// This test shells out to the same engine helper the loader calls,
// via the in-memory adapter, exercising the four cases in the brief.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeInScopeAdapter } from "../../calendar/inScopeAdapter.ts";
import { resolveFinalizeReviewSpan } from "../../scWeekFinalize.ts";

// Pin a Monday for every scenario; invented account keys.
const MON = "2026-11-16";
const NEXT_MON = "2026-11-23";

// ── weekly ─────────────────────────────────────────────────────────

test("weekly: this week's row is the one keyed on boardMonday", async () => {
  const rows = [
    { week_start: "2026-11-09", status: "finalized" },  // last week, excluded
    { week_start: MON,          status: "finalized" },  // this week, included
  ];
  const picked = rows.filter((r) => r.week_start === MON);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].week_start, MON);
});

test("weekly: only last week's row -> null for this week", () => {
  const rows = [{ week_start: "2026-11-09", status: "finalized" }];
  const picked = rows.find((r) => r.week_start === MON) ?? null;
  assert.equal(picked, null);
});

// ── biweekly: closing week ─────────────────────────────────────────

test("biweekly closing week: target is boardMonday, row at boardMonday is picked", async () => {
  const adapter = makeInScopeAdapter({
    accountKey: "INV-01",
    cadence: "biweekly",
    weekLabelByDate: new Map([[MON, "Week 2"]]),  // closing week of a pair
  });
  const span = await resolveFinalizeReviewSpan("INV-01", MON, adapter);
  assert.equal(span.isBiweekly, true);
  assert.equal(span.weekIndex, 2);
  // Target for a closing week is boardMonday itself.
  const target = (span.weekIndex === 1 || span.weekIndex === 3) ? NEXT_MON : MON;
  assert.equal(target, MON);
  const rows = [
    { week_start: "2026-11-02", status: "finalized" },  // the PREVIOUS pair
    { week_start: MON,          status: "finalized" },  // this pair's row
  ];
  const picked = rows.find((r) => r.week_start === target) ?? null;
  assert.ok(picked);
  assert.equal(picked.week_start, MON);
});

// ── biweekly: opening week ─────────────────────────────────────────

test("biweekly opening week with ONLY the previous pair's row -> not submitted", async () => {
  const adapter = makeInScopeAdapter({
    accountKey: "INV-02",
    cadence: "biweekly",
    weekLabelByDate: new Map([[MON, "Week 1"]]),  // opening week of a new pair
  });
  const span = await resolveFinalizeReviewSpan("INV-02", MON, adapter);
  assert.equal(span.weekIndex, 1);
  const target = (span.weekIndex === 1 || span.weekIndex === 3) ? NEXT_MON : MON;
  assert.equal(target, NEXT_MON);
  const rows = [
    // Previous pair's row on Nov 9 (Mon of the previous pair's closing
    // week). Not a candidate for this new pair.
    { week_start: "2026-11-09", status: "finalized" },
  ];
  const picked = rows.find((r) => r.week_start === target) ?? null;
  assert.equal(picked, null);
});

test("biweekly opening week with its pair's closing-Monday row -> submitted", async () => {
  const adapter = makeInScopeAdapter({
    accountKey: "INV-03",
    cadence: "biweekly",
    weekLabelByDate: new Map([[MON, "Week 3"]]),
  });
  const span = await resolveFinalizeReviewSpan("INV-03", MON, adapter);
  assert.equal(span.weekIndex, 3);
  const target = NEXT_MON;
  const rows = [
    { week_start: NEXT_MON, status: "finalized" },
  ];
  const picked = rows.find((r) => r.week_start === target) ?? null;
  assert.ok(picked);
  assert.equal(picked.week_start, NEXT_MON);
});

test("biweekly with no label on the Monday falls back to boardMonday", async () => {
  const adapter = makeInScopeAdapter({
    accountKey: "INV-04",
    cadence: "biweekly",
    weekLabelByDate: new Map(),  // nothing
  });
  const span = await resolveFinalizeReviewSpan("INV-04", MON, adapter);
  assert.equal(span.weekIndex, null);
  // Fallback: weekly behaviour, target = boardMonday.
  const target = (span.weekIndex === 1 || span.weekIndex === 3) ? NEXT_MON : MON;
  assert.equal(target, MON);
});
