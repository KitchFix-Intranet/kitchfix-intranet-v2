import { test } from "node:test";
import { strict as assert } from "node:assert";
import { filterUsualByActiveSet } from "../glCodes.ts";

const usual = {
  codes: [
    { code: "5000", name: "Food - Dairy", appearances: 10 },
    { code: "6000", name: "Wages", appearances: 4 },
    { code: "5100", name: "Food - Produce", appearances: 2 },
  ],
  singleCodeFill: { code: "5000", name: "Food - Dairy", appearances: 10 },
  sampleSize: 10,
};

test("filterUsualByActiveSet: keeps codes in the active set", () => {
  const r = filterUsualByActiveSet(usual, new Set(["5000", "5100"]));
  assert.deepEqual(r.codes.map((c) => c.code), ["5000", "5100"]);
  assert.equal(r.singleCodeFill?.code, "5000");
  assert.equal(r.sampleSize, 10);
});

test("filterUsualByActiveSet: drops a non-purchasing singleCodeFill", () => {
  // Wages is active=true but is_purchasing=false - shows up as a
  // usual code in history but never belongs in the Capture chip set.
  const payload = { ...usual, singleCodeFill: { code: "6000", name: "Wages", appearances: 10 } };
  const r = filterUsualByActiveSet(payload, new Set(["5000", "5100"]));
  assert.equal(r.singleCodeFill, null);
});

test("filterUsualByActiveSet: empty active set drops everything", () => {
  const r = filterUsualByActiveSet(usual, new Set());
  assert.deepEqual(r.codes, []);
  assert.equal(r.singleCodeFill, null);
  assert.equal(r.sampleSize, 10);
});
