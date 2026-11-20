import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mayDeliver } from "../mayDeliver.ts";

// Correction 3: all six combinations named.

test("mayDeliver: row=test, switch=off -> false", () => {
  assert.equal(mayDeliver("test", "off"), false);
});

test("mayDeliver: row=test, switch=test -> true", () => {
  assert.equal(mayDeliver("test", "test"), true);
});

test("mayDeliver: row=test, switch=live -> true", () => {
  // A test row still deliverable under live - it goes to the
  // test address (recipients.ts) and the row stays marked test
  // forever.
  assert.equal(mayDeliver("test", "live"), true);
});

test("mayDeliver: row=live, switch=off -> false", () => {
  assert.equal(mayDeliver("live", "off"), false);
});

test("mayDeliver: row=live, switch=test -> false", () => {
  // A row saved as live cannot deliver while the switch is only
  // in test: the operator pulled the switch back and we don't
  // leak a live row through.
  assert.equal(mayDeliver("live", "test"), false);
});

test("mayDeliver: row=live, switch=live -> true", () => {
  assert.equal(mayDeliver("live", "live"), true);
});
