// Fix 2 (train 4b): the week check + the finish must exclude
// services marked export_excluded from the day/week dollars, the
// same way the board and the engine already do. One helper
// (sumBillablePretaxCents) decides every surface.
//
// The test pins the invariant directly on the helper with a
// week-shaped payload: one billed line + one excluded line, both
// with counts above zero. Day total, week total and finish total
// all come from this helper now, so a single assertion pins all
// three surfaces at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sumBillablePretaxCents } from "../billableTotal.ts";

// Invented service ids; invented account; no real client.
const BILLED   = "svc-billed";
const EXCLUDED = "svc-excluded";

test("one billed + one excluded on the same day: total excludes the excluded line", () => {
  const rows = [
    { service_id: BILLED,   is_non_revenue: false, has_actuals: true, actual_revenue: 100.00 },
    { service_id: EXCLUDED, is_non_revenue: false, has_actuals: true, actual_revenue: 50.00 },
  ];
  const cents = sumBillablePretaxCents(rows, new Set([EXCLUDED]));
  assert.equal(cents, 10000);  // 100.00 only, in cents
});

test("empty exclusion set: both lines count", () => {
  const rows = [
    { service_id: BILLED,   is_non_revenue: false, has_actuals: true, actual_revenue: 100.00 },
    { service_id: EXCLUDED, is_non_revenue: false, has_actuals: true, actual_revenue: 50.00 },
  ];
  const cents = sumBillablePretaxCents(rows, new Set());
  assert.equal(cents, 15000);
});

test("non-revenue stays excluded regardless of the service map", () => {
  const rows = [
    { service_id: BILLED, is_non_revenue: false, has_actuals: true, actual_revenue: 100.00 },
    { service_id: "nr",   is_non_revenue: true,  has_actuals: true, actual_revenue: 25.00 },
  ];
  const cents = sumBillablePretaxCents(rows, new Set());
  assert.equal(cents, 10000);
});

test("week total: sum of per-day totals from the same helper", () => {
  // Two days of the same shape -> twice the single-day total.
  const day = [
    { service_id: BILLED,   is_non_revenue: false, has_actuals: true, actual_revenue: 100.00 },
    { service_id: EXCLUDED, is_non_revenue: false, has_actuals: true, actual_revenue: 50.00 },
  ];
  const d1 = sumBillablePretaxCents(day, new Set([EXCLUDED]));
  const d2 = sumBillablePretaxCents(day, new Set([EXCLUDED]));
  assert.equal(d1 + d2, 20000);
});

test("has_actuals false is skipped even without an exclusion", () => {
  const rows = [
    { service_id: BILLED, is_non_revenue: false, has_actuals: false, actual_revenue: 100.00 },
  ];
  assert.equal(sumBillablePretaxCents(rows, new Set()), 0);
});
