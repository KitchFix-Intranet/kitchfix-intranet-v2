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

// ─── applySingleCodeFill: train 2b round-2 fix #2 ────────────────
//
// The mark ("the tool filled this, the user has not touched it")
// is passed IN and the new value is returned OUT. Nothing about it
// lives on the row. When the helper has nothing to change it
// returns the SAME coding reference so the component's
// `next !== current` guard holds and an unchanged total does not
// stage a save.

const fill = { code: "5000", name: "Food - Dairy" };

test("applySingleCodeFill: no fillCode -> coding same ref, mark false", () => {
  const coding = [];
  const r = applySingleCodeFill(100, coding, null, true);
  assert.equal(r.coding, coding);
  assert.equal(r.isFilled, false);

  const otherCoding = [{ code: "5100", name: "Produce", amount: 50 }];
  const r2 = applySingleCodeFill(100, otherCoding, null, true);
  assert.equal(r2.coding, otherCoding);
  assert.equal(r2.isFilled, false);
});

test("applySingleCodeFill: total null -> coding same ref, mark carries forward", () => {
  const coding = [];
  const r = applySingleCodeFill(null, coding, fill, true);
  assert.equal(r.coding, coding);
  assert.equal(r.isFilled, true);

  const r2 = applySingleCodeFill(null, coding, fill, false);
  assert.equal(r2.coding, coding);
  assert.equal(r2.isFilled, false);
});

test("applySingleCodeFill: coding empty + total present -> plants line + marks", () => {
  const r = applySingleCodeFill(100, [], fill, false);
  assert.deepEqual(r.coding, [{ code: "5000", name: "Food - Dairy", amount: 100 }]);
  assert.equal(r.isFilled, true);
});

test("applySingleCodeFill: marked line tracks the total", () => {
  // User typed "1", tool filled (mark true); user typed "10";
  // the amount updates, mark stays true.
  let r = applySingleCodeFill(1, [], fill, false);
  assert.equal(r.isFilled, true);
  r = applySingleCodeFill(10, r.coding, fill, r.isFilled);
  assert.equal(r.coding.length, 1);
  assert.equal(r.coding[0].amount, 10);
  assert.equal(r.isFilled, true);
});

test("applySingleCodeFill: total unchanged -> same coding ref, mark stays true", () => {
  const coding = [{ code: "5000", name: "Food - Dairy", amount: 50 }];
  const r = applySingleCodeFill(50, coding, fill, true);
  assert.equal(r.coding, coding);         // reference-equal: no save staged
  assert.equal(r.isFilled, true);
});

test("applySingleCodeFill: user has touched the line -> hands off, mark stays false", () => {
  // The component clears the mark on updateLine; this is what the
  // helper sees on the next keystroke.
  const coding = [{ code: "5000", name: "Food - Dairy", amount: 999 }];
  const r = applySingleCodeFill(50, coding, fill, false);
  assert.equal(r.coding, coding);
  assert.equal(r.isFilled, false);
});

test("applySingleCodeFill: code no longer matches -> hands off, mark flips to false", () => {
  const coding = [{ code: "5100", name: "Produce", amount: 50 }];
  const r = applySingleCodeFill(100, coding, fill, true);
  assert.equal(r.coding, coding);
  assert.equal(r.isFilled, false);
});

test("applySingleCodeFill: more than one line -> hands off, mark false", () => {
  // Splitting is a deliberate user action; never overwrite it.
  const coding = [
    { code: "5000", name: "Food - Dairy", amount: 60 },
    { code: "5100", name: "Produce", amount: 40 },
  ];
  const r = applySingleCodeFill(100, coding, fill, true);
  assert.equal(r.coding, coding);
  assert.equal(r.isFilled, false);
});
