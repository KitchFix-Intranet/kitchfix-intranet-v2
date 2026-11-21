import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseSubmitterName } from "../submitterName.ts";

test("First + Last -> first + last initial", () => {
  assert.deepEqual(parseSubmitterName("Jane Doe"), { first_name: "Jane", last_initial: "D" });
});

test("three names -> first + last initial (uses the last word)", () => {
  assert.deepEqual(parseSubmitterName("Jane Mary Doe"), { first_name: "Jane", last_initial: "D" });
});

test("single name -> first only, no initial", () => {
  assert.deepEqual(parseSubmitterName("Prince"), { first_name: "Prince", last_initial: null });
});

test("extra whitespace collapses", () => {
  assert.deepEqual(parseSubmitterName("  Jane   Doe  "), { first_name: "Jane", last_initial: "D" });
});

test("null / empty / blank -> nulls", () => {
  assert.deepEqual(parseSubmitterName(null), { first_name: null, last_initial: null });
  assert.deepEqual(parseSubmitterName(""), { first_name: null, last_initial: null });
  assert.deepEqual(parseSubmitterName("   "), { first_name: null, last_initial: null });
});

test("lower-case last name uppercases the initial", () => {
  assert.deepEqual(parseSubmitterName("jane doe"), { first_name: "jane", last_initial: "D" });
});

test("non-letter last initial returns null initial (no fake letter)", () => {
  assert.deepEqual(parseSubmitterName("Jane '"), { first_name: "Jane", last_initial: null });
});
