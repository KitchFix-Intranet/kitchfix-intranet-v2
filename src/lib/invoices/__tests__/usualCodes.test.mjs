import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeUsualCodes } from "../usualCodes.ts";

const line = (code, amount, name = code) => ({ code, name, amount });
const inv = (total, lines) => ({ total_amount: total, gl_breakdown: lines });

test("usualCodes: fewer than 10 past invoices -> no fill", () => {
  const past = Array.from({ length: 9 }, () => inv(100, [line("5000", 100)]));
  const r = computeUsualCodes(past);
  assert.equal(r.sampleSize, 9);
  assert.equal(r.singleCodeFill, null);
  assert.equal(r.codes[0].code, "5000");
  assert.equal(r.codes[0].appearances, 9);
});

test("usualCodes: 9 of 10 single-code -> fill fires", () => {
  const past = [
    ...Array.from({ length: 9 }, () => inv(100, [line("5000", 100)])),
    inv(100, [line("5000", 60), line("5100", 40)]), // split; does not count for fill
  ];
  const r = computeUsualCodes(past);
  assert.equal(r.sampleSize, 10);
  assert.equal(r.singleCodeFill?.code, "5000");
  assert.equal(r.singleCodeFill?.appearances, 9);
});

test("usualCodes: 8 of 10 single-code -> no fill", () => {
  const past = [
    ...Array.from({ length: 8 }, () => inv(100, [line("5000", 100)])),
    inv(100, [line("5000", 60), line("5100", 40)]),
    inv(100, [line("5000", 50), line("5200", 50)]),
  ];
  const r = computeUsualCodes(past);
  assert.equal(r.singleCodeFill, null);
});

test("usualCodes: 10 split invoices -> no fill, codes ranked", () => {
  const past = Array.from({ length: 10 }, () =>
    inv(100, [line("5000", 60), line("5100", 40)]),
  );
  const r = computeUsualCodes(past);
  assert.equal(r.singleCodeFill, null);
  assert.deepEqual(r.codes.map((c) => c.code), ["5000", "5100"]);
  assert.equal(r.codes[0].appearances, 10);
});

test("usualCodes: multi-line but one code wholes the amount -> still no fill", () => {
  // Rule: whole-amount "single-code" means exactly ONE distinct code
  // on that invoice; a split onto two codes does not count even if
  // one sums to the total.
  const past = Array.from({ length: 10 }, () =>
    inv(100, [line("5000", 100), line("5100", 0.5)]),
  );
  const r = computeUsualCodes(past);
  assert.equal(r.singleCodeFill, null);
});

test("usualCodes: two different codes each take the whole 5 times -> no fill", () => {
  const past = [
    ...Array.from({ length: 5 }, () => inv(100, [line("5000", 100)])),
    ...Array.from({ length: 5 }, () => inv(100, [line("5100", 100)])),
  ];
  const r = computeUsualCodes(past);
  assert.equal(r.singleCodeFill, null);
  assert.equal(r.codes.length, 2);
});

test("usualCodes: total mismatch disqualifies single-code hit", () => {
  // 9 rows where the code is the only one but amount != total.
  const past = [
    ...Array.from({ length: 9 }, () => inv(100, [line("5000", 50)])), // under-coded
    inv(100, [line("5000", 100)]),
  ];
  const r = computeUsualCodes(past);
  assert.equal(r.singleCodeFill, null);
});

test("usualCodes: empty past -> empty result", () => {
  const r = computeUsualCodes([]);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.singleCodeFill, null);
  assert.deepEqual(r.codes, []);
});
