import { test } from "node:test";
import { strict as assert } from "node:assert";
import { paginateCodingLines } from "../codingPagePaginate.ts";

test("no lines -> one empty page", () => {
  const r = paginateCodingLines([], 20, 40);
  assert.equal(r.pages.length, 1);
  assert.deepEqual(r.pages[0], []);
});

test("fewer lines than first-page cap -> one page, all lines", () => {
  const lines = ["a", "b", "c"];
  const r = paginateCodingLines(lines, 20, 40);
  assert.equal(r.pages.length, 1);
  assert.deepEqual(r.pages[0], ["a", "b", "c"]);
});

test("exactly first-page cap -> one page", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const r = paginateCodingLines(lines, 20, 40);
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].length, 20);
});

test("fix 3: 60 lines across pages - all 60 preserved, in order", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `l${i}`);
  const r = paginateCodingLines(lines, 20, 40);
  // 20 on page 1, 40 on page 2 -> 60 total.
  assert.equal(r.pages.length, 2);
  assert.equal(r.pages[0].length, 20);
  assert.equal(r.pages[1].length, 40);
  const flat = r.pages.flat();
  assert.equal(flat.length, 60);
  for (let i = 0; i < 60; i++) assert.equal(flat[i], `l${i}`);
});

test("three pages: 100 lines, first=20 then 40 + 40", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const r = paginateCodingLines(lines, 20, 40);
  assert.equal(r.pages.length, 3);
  assert.deepEqual(r.pages.map((p) => p.length), [20, 40, 40]);
  assert.equal(r.pages.flat().length, 100);
});

test("odd partition: first=20, full=40, 61 lines -> 20 + 40 + 1", () => {
  const lines = Array.from({ length: 61 }, (_, i) => `l${i}`);
  const r = paginateCodingLines(lines, 20, 40);
  assert.deepEqual(r.pages.map((p) => p.length), [20, 40, 1]);
});

test("firstPageCap=1 cap still works", () => {
  const lines = ["a", "b", "c"];
  const r = paginateCodingLines(lines, 1, 2);
  assert.deepEqual(r.pages.map((p) => p.length), [1, 2]);
});

test("bad caps throw", () => {
  assert.throws(() => paginateCodingLines(["a"], 0, 40));
  assert.throws(() => paginateCodingLines(["a"], 20, 0));
});
