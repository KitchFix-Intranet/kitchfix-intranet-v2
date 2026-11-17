import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveFirstNames, firstWord } from "../firstName.ts";

test("firstWord: first whitespace-split token, trimmed", () => {
  assert.equal(firstWord("Alex River"), "Alex");
  assert.equal(firstWord("  Jamie   Lee  "), "Jamie");
  assert.equal(firstWord("Sky"), "Sky");
  assert.equal(firstWord(""), null);
  assert.equal(firstWord(null), null);
});

test("resolveFirstNames: single ACTIVE row -> that first name", () => {
  const r = resolveFirstNames(
    ["a@x.co"],
    [{ work_email: "a@x.co", display_name: "Alex River", status: "ACTIVE" }],
  );
  assert.equal(r.get("a@x.co"), "Alex");
});

test("resolveFirstNames: no match -> null", () => {
  const r = resolveFirstNames(["ghost@x.co"], []);
  assert.equal(r.get("ghost@x.co"), null);
});

test("resolveFirstNames: no active, one inactive row -> that name", () => {
  const r = resolveFirstNames(
    ["b@x.co"],
    [{ work_email: "b@x.co", display_name: "Beth Last", status: "TERMINATED" }],
  );
  assert.equal(r.get("b@x.co"), "Beth");
});

test("resolveFirstNames: no active, two inactives with different names -> null", () => {
  const r = resolveFirstNames(
    ["c@x.co"],
    [
      { work_email: "c@x.co", display_name: "Chris A", status: "TERMINATED" },
      { work_email: "c@x.co", display_name: "Chris B", status: "TERMINATED" },
    ],
  );
  assert.equal(r.get("c@x.co"), null);
});

test("resolveFirstNames: two ACTIVE rows with same name -> that name", () => {
  const r = resolveFirstNames(
    ["d@x.co"],
    [
      { work_email: "d@x.co", display_name: "Dan Morrow", status: "ACTIVE" },
      { work_email: "d@x.co", display_name: "Dan Morrow", status: "ACTIVE" },
    ],
  );
  assert.equal(r.get("d@x.co"), "Dan");
});

test("resolveFirstNames: two ACTIVE rows disagreeing -> null (defect, not fallback)", () => {
  const r = resolveFirstNames(
    ["e@x.co"],
    [
      { work_email: "e@x.co", display_name: "Erin X", status: "ACTIVE" },
      { work_email: "e@x.co", display_name: "Erin Y", status: "ACTIVE" },
    ],
  );
  assert.equal(r.get("e@x.co"), null);
});

test("resolveFirstNames: case-insensitive email keying", () => {
  const r = resolveFirstNames(
    ["Alex@X.CO"],
    [{ work_email: "alex@x.co", display_name: "Alex River", status: "ACTIVE" }],
  );
  assert.equal(r.get("alex@x.co"), "Alex");
});
