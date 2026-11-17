import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fmtUsdExact } from "../money.ts";

test("fmtUsdExact: exact cents, no rounding", () => {
  // Made-up amounts so no real invoice value appears in the test.
  assert.equal(fmtUsdExact(318.75), "$318.75");
  assert.equal(fmtUsdExact(1), "$1.00");
  assert.equal(fmtUsdExact(0), "$0.00");
  assert.equal(fmtUsdExact(0.5), "$0.50");
});

test("fmtUsdExact: negatives with a single minus", () => {
  assert.equal(fmtUsdExact(-45.12), "-$45.12");
  assert.equal(fmtUsdExact(-1), "-$1.00");
});

test("fmtUsdExact: thousands separators", () => {
  assert.equal(fmtUsdExact(1234.5), "$1,234.50");
  assert.equal(fmtUsdExact(12345.67), "$12,345.67");
  assert.equal(fmtUsdExact(1234567.89), "$1,234,567.89");
});

test("fmtUsdExact: NaN and Infinity collapse to dash", () => {
  assert.equal(fmtUsdExact(Number.NaN), "-");
  assert.equal(fmtUsdExact(Number.POSITIVE_INFINITY), "-");
  assert.equal(fmtUsdExact(Number.NEGATIVE_INFINITY), "-");
});
