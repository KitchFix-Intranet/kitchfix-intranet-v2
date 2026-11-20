import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseMoneyInput, looksLikeMoneyDuringTyping } from "../moneyInput.ts";

test("parseMoneyInput: plain digits with cents", () => {
  assert.equal(parseMoneyInput("123.45"), 123.45);
  assert.equal(parseMoneyInput("0.01"), 0.01);
  assert.equal(parseMoneyInput("0"), 0);
  assert.equal(parseMoneyInput("0.00"), 0);
});

test("parseMoneyInput: integers (no dot)", () => {
  assert.equal(parseMoneyInput("123"), 123);
  assert.equal(parseMoneyInput("1000"), 1000);
});

test("parseMoneyInput: thousands commas stripped", () => {
  assert.equal(parseMoneyInput("1,234.56"), 1234.56);
  assert.equal(parseMoneyInput("1,234,567.89"), 1234567.89);
  assert.equal(parseMoneyInput("1,234"), 1234);
});

test("parseMoneyInput: leading $ accepted", () => {
  assert.equal(parseMoneyInput("$12.34"), 12.34);
  assert.equal(parseMoneyInput("$ 12.34"), 12.34);
});

test("parseMoneyInput: lone decimal (.50) accepted", () => {
  assert.equal(parseMoneyInput(".50"), 0.5);
});

test("parseMoneyInput: trailing dot (12.) accepted during parse", () => {
  // "12." is valid: digits-dot-digits* pattern allows empty after
  // the dot. Parses to 12.
  assert.equal(parseMoneyInput("12."), 12);
});

test("parseMoneyInput: rejects garbage", () => {
  assert.equal(parseMoneyInput(""), null);
  assert.equal(parseMoneyInput(null), null);
  assert.equal(parseMoneyInput("abc"), null);
  assert.equal(parseMoneyInput("-5.00"), null); // no negatives
  assert.equal(parseMoneyInput("1.2.3"), null);
  assert.equal(parseMoneyInput("1e3"), null);
});

test("parseMoneyInput: rounds to cents", () => {
  // Three-decimal inputs are odd on an invoice but we round them.
  // Math.round on *100 is floating-point-exact for these two:
  assert.equal(parseMoneyInput("1.006"), 1.01);
  assert.equal(parseMoneyInput("1.004"), 1); // rounds down to .00
});

test("looksLikeMoneyDuringTyping: mid-typing allowances", () => {
  assert.equal(looksLikeMoneyDuringTyping(""), true);
  assert.equal(looksLikeMoneyDuringTyping("1"), true);
  assert.equal(looksLikeMoneyDuringTyping("12"), true);
  assert.equal(looksLikeMoneyDuringTyping("12."), true);
  assert.equal(looksLikeMoneyDuringTyping("12.3"), true);
  assert.equal(looksLikeMoneyDuringTyping("12.34"), true);
  assert.equal(looksLikeMoneyDuringTyping("."), true);
  assert.equal(looksLikeMoneyDuringTyping("$"), true); // leading $
  assert.equal(looksLikeMoneyDuringTyping("1,234"), true);
  assert.equal(looksLikeMoneyDuringTyping("abc"), false);
  assert.equal(looksLikeMoneyDuringTyping("-1"), false);
});
