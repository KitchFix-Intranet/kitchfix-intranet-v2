import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeInvoiceNumber, sameInvoiceNumber } from "../invNumber.ts";

test("invoice_number_normalized: leading # stripped", () => {
  assert.equal(normalizeInvoiceNumber("#123"), "123");
  assert.equal(normalizeInvoiceNumber("#abc"), "abc");
});

test("invoice_number_normalized: leading zeros stripped, one digit kept", () => {
  assert.equal(normalizeInvoiceNumber("00123"), "123");
  assert.equal(normalizeInvoiceNumber("000000"), "0"); // not "", keeps one digit
  assert.equal(normalizeInvoiceNumber("#0"), "0");
});

test("invoice_number_normalized: # and zeros combined", () => {
  assert.equal(normalizeInvoiceNumber("#00123"), "123");
});

test("invoice_number_normalized: non-digit leads are preserved then lowered", () => {
  assert.equal(normalizeInvoiceNumber("A-00123"), "a-00123");
  assert.equal(normalizeInvoiceNumber("INV123"), "inv123");
});

test("invoice_number_normalized: trimmed, blanks are empty", () => {
  assert.equal(normalizeInvoiceNumber("  123 "), "123");
  assert.equal(normalizeInvoiceNumber(""), "");
  assert.equal(normalizeInvoiceNumber(null), "");
  assert.equal(normalizeInvoiceNumber(undefined), "");
});

test("sameInvoiceNumber: empty never matches", () => {
  assert.equal(sameInvoiceNumber("", "123"), false);
  assert.equal(sameInvoiceNumber("123", null), false);
});

test("sameInvoiceNumber: equivalent forms match", () => {
  assert.equal(sameInvoiceNumber("00123", "123"), true);
  assert.equal(sameInvoiceNumber("#123", "123"), true);
  assert.equal(sameInvoiceNumber("#00123", "00123"), true);
  assert.equal(sameInvoiceNumber("#00123", "123"), true);
});

test("sameInvoiceNumber: different numbers do not match", () => {
  assert.equal(sameInvoiceNumber("123", "124"), false);
  assert.equal(sameInvoiceNumber("A123", "B123"), false);
});
