import { test } from "node:test";
import { strict as assert } from "node:assert";
import { addsUp, leftToCode, sumGlCents, toCents } from "../addUp.ts";

const line = (code, amount, name = code) => ({ code, name, amount });

test("addsUp: one line equal to total", () => {
  assert.equal(addsUp(100, [line("5000", 100)]), true);
});

test("addsUp: multiple lines summing to total", () => {
  assert.equal(addsUp(100, [line("5000", 60), line("5100", 40)]), true);
});

test("addsUp: cent-level mismatch fails", () => {
  // Float-safe: 0.1 + 0.2 = 0.30000000000000004 - but we convert to
  // integer cents first, so this still equals.
  assert.equal(addsUp(0.3, [line("5000", 0.1), line("5100", 0.2)]), true);
  // One cent over
  assert.equal(addsUp(100, [line("5000", 100.01)]), false);
  // One cent under
  assert.equal(addsUp(100, [line("5000", 99.99)]), false);
});

test("addsUp: empty lines never add up", () => {
  assert.equal(addsUp(100, []), false);
  assert.equal(addsUp(0, []), true); // zero total + zero lines agree
});

test("addsUp: null total always false", () => {
  assert.equal(addsUp(null, [line("5000", 100)]), false);
});

test("leftToCode: counts down to zero", () => {
  assert.equal(leftToCode(100, []), 100);
  assert.equal(leftToCode(100, [line("5000", 30)]), 70);
  assert.equal(leftToCode(100, [line("5000", 100)]), 0);
});

test("leftToCode: negative when over-coded", () => {
  assert.equal(leftToCode(100, [line("5000", 110)]), -10);
});

test("sumGlCents + toCents: integer safety", () => {
  assert.equal(toCents(1.23), 123);
  assert.equal(toCents(0), 0);
  assert.equal(sumGlCents([line("a", 0.1), line("b", 0.2), line("c", 0.3)]), 60);
});
