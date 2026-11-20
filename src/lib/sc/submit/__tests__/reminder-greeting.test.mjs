import { test } from "node:test";
import assert from "node:assert/strict";
import { reminderGreeting } from "../reminderGreeting.ts";

test("empty list -> 'Hi,'", () => {
  assert.equal(reminderGreeting([]), "Hi,");
});

test("all names blank -> 'Hi,'", () => {
  assert.equal(reminderGreeting(["", null, "   "]), "Hi,");
});

test("one name uses first word", () => {
  assert.equal(reminderGreeting(["Casey Wells"]), "Hi Casey,");
});

test("two names join with 'and'", () => {
  assert.equal(reminderGreeting(["Casey Wells", "Morgan Ash"]), "Hi Casey and Morgan,");
});

test("three names use Oxford-less list with 'and'", () => {
  assert.equal(
    reminderGreeting(["Casey Wells", "Morgan Ash", "Taylor Vee"]),
    "Hi Casey, Morgan and Taylor,",
  );
});

test("four or more names collapse to 'Hi all,'", () => {
  assert.equal(
    reminderGreeting(["Casey", "Morgan", "Taylor", "Rowan"]),
    "Hi all,",
  );
});

test("multi-word names use the first word only", () => {
  assert.equal(
    reminderGreeting(["Jean Luc Picard", "Beverly Crusher"]),
    "Hi Jean and Beverly,",
  );
});
