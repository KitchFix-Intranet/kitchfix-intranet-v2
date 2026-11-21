import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildCodingPageData } from "../codingPageData.ts";

const INVOICE = Object.freeze({
  account_key: "SITE_A",
  vendor_name: "Acme Foods",
  invoice_number: "ABC-1",
  invoice_date: "2026-11-02",
  total_amount: 1234.56,
  type: "invoice",
  gl_breakdown: [
    { code: "5000", name: "Food - Dry", amount: 1000 },
    { code: "5100", name: "Food - Produce", amount: 234.56 },
  ],
  submitted_at: "2026-11-02T18:05:00Z",
});

test("coding data for an invoice, live mode", () => {
  const d = buildCodingPageData(INVOICE, { first_name: "Jane", last_initial: "D" }, "live");
  assert.equal(d.isTest, false);
  assert.equal(d.title, "Invoice");
  assert.equal(d.site, "SITE_A");
  assert.equal(d.vendor, "Acme Foods");
  assert.equal(d.kindLabel, "Invoice");
  assert.equal(d.numberLabel, "Invoice number");
  assert.equal(d.number, "ABC-1");
  assert.equal(d.dateLabel, "Invoice date");
  assert.equal(d.dateDisplay, "11/02/2026");
  assert.equal(d.totalLabel, "Total");
  assert.equal(d.totalDisplay, "$1,234.56");
  assert.deepEqual(d.lines.map((l) => l.amountDisplay), ["$1,000.00", "$234.56"]);
  assert.equal(d.byline, "Jane D");
  // Fix 2.5: Central time, 12h, with zone. 18:05 UTC on Nov 2
  // 2026 (CST, UTC-6) renders as 12:05 PM CT.
  assert.equal(d.whenDisplay, "11/02/2026 12:05 PM CT");
});

test("coding data for a credit: labels flip, total shows positive", () => {
  const d = buildCodingPageData({
    ...INVOICE,
    type: "credit",
    total_amount: -1234.56,
    gl_breakdown: [{ code: "5000", name: "Food - Dry", amount: -1234.56 }],
  }, { first_name: "Jane", last_initial: "D" }, "live");
  assert.equal(d.title, "Credit");
  assert.equal(d.kindLabel, "Credit");
  assert.equal(d.numberLabel, "Credit number");
  assert.equal(d.dateLabel, "Credit date");
  assert.equal(d.totalLabel, "Credit total");
  assert.equal(d.totalDisplay, "$1,234.56");
  assert.equal(d.lines[0].amountDisplay, "$1,234.56");
});

test("test mode sets isTest and leaves everything else alone", () => {
  const d = buildCodingPageData(INVOICE, { first_name: "Jane", last_initial: "D" }, "test");
  assert.equal(d.isTest, true);
  assert.equal(d.totalDisplay, "$1,234.56");
});

test("byline uses first name only when the last initial is missing", () => {
  const d = buildCodingPageData(INVOICE, { first_name: "Jane", last_initial: null }, "live");
  assert.equal(d.byline, "Jane");
});

test("byline is null when the people row is missing (no name from email)", () => {
  const d = buildCodingPageData(INVOICE, { first_name: null, last_initial: null }, "live");
  assert.equal(d.byline, null);
});

test("whole-dollar total shows .00", () => {
  const d = buildCodingPageData({ ...INVOICE, total_amount: 500 }, { first_name: null, last_initial: null }, "live");
  assert.equal(d.totalDisplay, "$500.00");
});

test("thousands commas on a six-figure total", () => {
  const d = buildCodingPageData({ ...INVOICE, total_amount: 123456.78 }, { first_name: null, last_initial: null }, "live");
  assert.equal(d.totalDisplay, "$123,456.78");
});
