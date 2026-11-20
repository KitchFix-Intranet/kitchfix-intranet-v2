import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseDateInput, toBoxDate } from "../dateInput.ts";

// Pin "today" (Chicago) at 2026-11-17. Use noon UTC so the Chicago
// date is 06:00 same day regardless of DST shenanigans.
const TODAY = new Date("2026-11-17T18:00:00Z");

test("parseDateInput: ISO YYYY-MM-DD (calendar pick)", () => {
  const r = parseDateInput("2026-11-01", TODAY);
  assert.equal(r.iso, "2026-11-01");
  assert.equal(r.future, false);
  assert.equal(r.moreThan60DaysBack, false);
});

test("parseDateInput: MM/DD/YYYY", () => {
  const r = parseDateInput("11/01/2026", TODAY);
  assert.equal(r.iso, "2026-11-01");
  assert.equal(r.future, false);
  const r2 = parseDateInput("1/5/2026", TODAY);
  assert.equal(r2.iso, "2026-01-05");
});

test("parseDateInput: MMDDYYYY (8 digits, no punctuation)", () => {
  const r = parseDateInput("11012026", TODAY);
  assert.equal(r.iso, "2026-11-01");
  assert.equal(r.future, false);
});

test("parseDateInput: future date flagged", () => {
  const r = parseDateInput("12/31/2026", TODAY);
  assert.equal(r.iso, "2026-12-31");
  assert.equal(r.future, true);
});

test("parseDateInput: >60 days back flagged", () => {
  // 2026-11-17 minus 61 days = 2026-09-17
  const r = parseDateInput("09/17/2026", TODAY);
  assert.equal(r.iso, "2026-09-17");
  assert.equal(r.future, false);
  assert.equal(r.moreThan60DaysBack, true);
});

test("parseDateInput: exactly 60 days back is NOT >60", () => {
  // 2026-11-17 minus 60 days = 2026-09-18
  const r = parseDateInput("09/18/2026", TODAY);
  assert.equal(r.moreThan60DaysBack, false);
});

test("parseDateInput: today is not future and not >60", () => {
  const r = parseDateInput("2026-11-17", TODAY);
  assert.equal(r.iso, "2026-11-17");
  assert.equal(r.future, false);
  assert.equal(r.moreThan60DaysBack, false);
});

test("parseDateInput: invalid rejects", () => {
  assert.equal(parseDateInput("", TODAY).iso, null);
  assert.equal(parseDateInput(null, TODAY).iso, null);
  assert.equal(parseDateInput("13/01/2026", TODAY).iso, null); // month
  assert.equal(parseDateInput("02/30/2026", TODAY).iso, null); // Feb 30
  assert.equal(parseDateInput("12/32/2026", TODAY).iso, null); // day
  assert.equal(parseDateInput("1/1/26", TODAY).iso, null);     // two-digit year rejected
  assert.equal(parseDateInput("abc", TODAY).iso, null);
  assert.equal(parseDateInput("1234567", TODAY).iso, null);    // 7 digits
  assert.equal(parseDateInput("123456789", TODAY).iso, null);  // 9 digits
});

test("parseDateInput: leap-day boundary", () => {
  const today = new Date("2028-03-01T18:00:00Z");
  const good = parseDateInput("02/29/2028", today); // 2028 is a leap year
  assert.equal(good.iso, "2028-02-29");
  const bad = parseDateInput("02/29/2027", today);  // not a leap year
  assert.equal(bad.iso, null);
});

test("toBoxDate: formats ISO to MM/DD/YYYY without timezone shift", () => {
  assert.equal(toBoxDate("2026-11-17"), "11/17/2026");
  assert.equal(toBoxDate("2026-01-05"), "01/05/2026");
  assert.equal(toBoxDate("2026-12-31"), "12/31/2026");
});

test("toBoxDate: empty / malformed returns empty string", () => {
  assert.equal(toBoxDate(null), "");
  assert.equal(toBoxDate(undefined), "");
  assert.equal(toBoxDate(""), "");
  assert.equal(toBoxDate("11/17/2026"), "");
  assert.equal(toBoxDate("2026-11-17T00:00:00Z"), "");
});

test("toBoxDate <-> parseDateInput: round trip", () => {
  const today = new Date("2026-11-17T18:00:00Z");
  for (const iso of ["2026-11-17", "2026-01-05", "2026-12-31", "2028-02-29"]) {
    const box = toBoxDate(iso);
    const back = parseDateInput(box, today);
    assert.equal(back.iso, iso, `round trip failed for ${iso}`);
  }
});
