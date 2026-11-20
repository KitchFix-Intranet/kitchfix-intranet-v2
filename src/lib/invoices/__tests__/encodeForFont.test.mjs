import { test } from "node:test";
import { strict as assert } from "node:assert";
import { encodeForFont } from "../encodeForFont.ts";

test("ASCII passes through unchanged", () => {
  assert.equal(encodeForFont(""), "");
  assert.equal(encodeForFont("Hello World"), "Hello World");
  assert.equal(encodeForFont("Invoice #ABC-1 / 42.00 EUR"), "Invoice #ABC-1 / 42.00 EUR");
});

test("Latin-1 supplement passes (accents are fine)", () => {
  assert.equal(encodeForFont("Café"), "Café");
  assert.equal(encodeForFont("naïve résumé"), "naïve résumé");
});

test("non-break space passes", () => {
  assert.equal(encodeForFont("a b"), "a b");
});

test("tab becomes space", () => {
  assert.equal(encodeForFont("a\tb"), "a b");
});

test("emoji becomes a single ?", () => {
  // Thumbs up U+1F44D is a surrogate pair in JS.
  assert.equal(encodeForFont("good \u{1F44D} job"), "good ? job");
  assert.equal(encodeForFont("\u{1F44D}"), "?");
});

test("CJK (Japanese) becomes ?s", () => {
  // Three CJK chars -> three ?s.
  assert.equal(encodeForFont("日本語"), "???");
  assert.equal(encodeForFont("Tokyo 東京"), "Tokyo ??");
});

test("curly quotes + em-dash drop to ? (WinAnsi-quirky range)", () => {
  // U+2013 EN DASH, U+2014 EM DASH, U+2018 L-S-QUOTE, etc.
  assert.equal(encodeForFont("—"), "?");
  assert.equal(encodeForFont("‘hi’"), "?hi?");
});

test("control chars drop to ?", () => {
  assert.equal(encodeForFont("ab"), "a?b");
  assert.equal(encodeForFont(""), "?");
});

test("dangling low surrogate becomes ?", () => {
  // A broken sequence - not supposed to happen but shouldn't crash.
  assert.equal(encodeForFont("\uDC00"), "?");
});

test("mixed string: only unencodable chars change", () => {
  assert.equal(encodeForFont("Jane 日 Doe \u{1F44D}"), "Jane ? Doe ?");
});
