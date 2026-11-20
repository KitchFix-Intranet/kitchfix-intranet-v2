import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeUsualCodes, applySingleCodeFill } from "../usualCodes.ts";

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

// ─── applySingleCodeFill: train 2b fix-before-push #4 ─────────────

const fill = { code: "5000", name: "Food - Dairy" };

test("applySingleCodeFill: no fillCode -> no change", () => {
  assert.deepEqual(applySingleCodeFill(100, [], null), []);
  const coding = [{ code: "5100", name: "Produce", amount: 50 }];
  assert.deepEqual(applySingleCodeFill(100, coding, null), coding);
});

test("applySingleCodeFill: total null -> no change", () => {
  assert.deepEqual(applySingleCodeFill(null, [], fill), []);
});

test("applySingleCodeFill: coding empty + total present -> plants auto line", () => {
  const next = applySingleCodeFill(100, [], fill);
  assert.deepEqual(next, [{ code: "5000", name: "Food - Dairy", amount: 100, auto: true }]);
});

test("applySingleCodeFill: coding is the tool's auto line -> amount follows the total", () => {
  // User typed "1", tool filled; then user typed "10"; tool must
  // update the amount, not leave it at 1.
  let coding = applySingleCodeFill(1, [], fill);
  coding = applySingleCodeFill(10, coding, fill);
  assert.equal(coding.length, 1);
  assert.equal(coding[0].amount, 10);
  assert.equal(coding[0].auto, true);
});

test("applySingleCodeFill: total unchanged -> same reference-equal values", () => {
  const coding = [{ code: "5000", name: "Food - Dairy", amount: 50, auto: true }];
  const next = applySingleCodeFill(50, coding, fill);
  // Behavior: when amount already matches, the helper returns the
  // same shape (no-op from the user's POV).
  assert.equal(next.length, 1);
  assert.equal(next[0].amount, 50);
  assert.equal(next[0].auto, true);
});

test("applySingleCodeFill: user edited the amount -> hands off", () => {
  // auto=false: the user has touched this line. The tool stops
  // writing to it even though the total changes.
  const coding = [{ code: "5000", name: "Food - Dairy", amount: 999, auto: false }];
  const next = applySingleCodeFill(50, coding, fill);
  assert.deepEqual(next, coding);
});

test("applySingleCodeFill: user changed the code -> hands off", () => {
  // The code no longer matches the fill - user picked something
  // else. Leave it alone.
  const coding = [{ code: "5100", name: "Produce", amount: 50, auto: true }];
  const next = applySingleCodeFill(100, coding, fill);
  assert.deepEqual(next, coding);
});

test("applySingleCodeFill: more than one line -> hands off", () => {
  // Splitting is a deliberate user action; never overwrite it.
  const coding = [
    { code: "5000", name: "Food - Dairy", amount: 60, auto: false },
    { code: "5100", name: "Produce", amount: 40, auto: false },
  ];
  const next = applySingleCodeFill(100, coding, fill);
  assert.deepEqual(next, coding);
});
