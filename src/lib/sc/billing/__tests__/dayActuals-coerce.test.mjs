// coerceActualCount: 400s malformed input; 0 for empty; passes through
// valid non-negative integers.

import test from "node:test";
import assert from "node:assert/strict";
import { coerceActualCount, ActualCountValidationError } from "../../dayActuals/coerceActualCount.ts";

test("coerce: null / undefined / empty => 0", () => {
  assert.equal(coerceActualCount(null, "s-1"), 0);
  assert.equal(coerceActualCount(undefined, "s-1"), 0);
  assert.equal(coerceActualCount("", "s-1"), 0);
});

test("coerce: non-negative integers pass through", () => {
  assert.equal(coerceActualCount(0, "s-1"), 0);
  assert.equal(coerceActualCount(42, "s-1"), 42);
  assert.equal(coerceActualCount("42", "s-1"), 42);
});

test("coerce: a decimal throws with service id", () => {
  assert.throws(() => coerceActualCount(1.5, "svc-x"), (e) => e instanceof ActualCountValidationError && e.serviceId === "svc-x");
});

test("coerce: a negative number throws with service id", () => {
  assert.throws(() => coerceActualCount(-3, "svc-x"), (e) => e instanceof ActualCountValidationError && e.serviceId === "svc-x");
});

test("coerce: a non-numeric string throws with service id", () => {
  assert.throws(() => coerceActualCount("abc", "svc-x"), (e) => e instanceof ActualCountValidationError && e.serviceId === "svc-x");
});

test("coerce: NaN throws with service id", () => {
  assert.throws(() => coerceActualCount(Number.NaN, "svc-x"), (e) => e instanceof ActualCountValidationError);
});
