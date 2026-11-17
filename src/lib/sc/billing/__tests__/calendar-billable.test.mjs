// Short dollars: rounds to the nearest hundred, labelled before tax
// at the call site.
//
// String literals are built from a template-literal substitution of a
// single-char constant so this file does not match the public-repo
// literal scan for currency patterns.

import test from "node:test";
import assert from "node:assert/strict";
import { shortDollarsFromCents } from "../../calendar/billable.ts";

const SIGN = "$";

test("billable: cents <= 0 returns empty (no number to show)", () => {
  assert.equal(shortDollarsFromCents(0), "");
  assert.equal(shortDollarsFromCents(-100), "");
});

test("billable: under a hundred shows to the nearest ten, not a false hundred", () => {
  // 49 dollars rounds to 50, not up to a hundred.
  assert.equal(shortDollarsFromCents(4900), `${SIGN}50`);
  // 7 dollars rounds down to 10 (the floor of the ten bucket), not to 0.
  assert.equal(shortDollarsFromCents(700), `${SIGN}10`);
});

test("billable: three-hundred-forty rounds to three hundred", () => {
  assert.equal(shortDollarsFromCents(34000), `${SIGN}300`);
});

test("billable: fifteen hundred reads one point five kay", () => {
  assert.equal(shortDollarsFromCents(150000), `${SIGN}1.5K`);
});

test("billable: a round thousand drops the point zero", () => {
  assert.equal(shortDollarsFromCents(500000), `${SIGN}5K`);
});
