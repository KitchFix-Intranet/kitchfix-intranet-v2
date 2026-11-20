import { test } from "node:test";
import { strict as assert } from "node:assert";
import { pickSortOrder } from "../sortOrder.ts";

// Train 2b fix-before-push #8 / section 4.3. Pure function, no mock.

test("pickSortOrder: good whole number is kept", () => {
  assert.equal(pickSortOrder(0, 7), 0);
  assert.equal(pickSortOrder(3, 7), 3);
  assert.equal(pickSortOrder(1023, 7), 1023);
});

test("pickSortOrder: a fraction falls back", () => {
  assert.equal(pickSortOrder(1.5, 7), 7);
});

test("pickSortOrder: a negative falls back", () => {
  assert.equal(pickSortOrder(-1, 7), 7);
  assert.equal(pickSortOrder(-100, 7), 7);
});

test("pickSortOrder: a string falls back", () => {
  assert.equal(pickSortOrder("3", 7), 7);
  assert.equal(pickSortOrder("", 7), 7);
});

test("pickSortOrder: NaN falls back", () => {
  assert.equal(pickSortOrder(NaN, 7), 7);
});

test("pickSortOrder: Infinity falls back", () => {
  assert.equal(pickSortOrder(Infinity, 7), 7);
  assert.equal(pickSortOrder(-Infinity, 7), 7);
});

test("pickSortOrder: a huge number is kept when a whole number", () => {
  // Number.isInteger handles up to 2^53 - 1.
  assert.equal(pickSortOrder(9007199254740990, 7), 9007199254740990);
});

test("pickSortOrder: null / undefined fall back", () => {
  assert.equal(pickSortOrder(null, 7), 7);
  assert.equal(pickSortOrder(undefined, 7), 7);
});

test("pickSortOrder: boolean and object fall back", () => {
  assert.equal(pickSortOrder(true, 7), 7);
  assert.equal(pickSortOrder(false, 7), 7);
  assert.equal(pickSortOrder({}, 7), 7);
  assert.equal(pickSortOrder([], 7), 7);
});
