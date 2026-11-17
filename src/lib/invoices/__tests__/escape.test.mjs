import { test } from "node:test";
import { strict as assert } from "node:assert";
import { escapeLike } from "../escape.ts";

test("escapeLike: backslash before each LIKE metachar", () => {
  assert.equal(escapeLike("abc"), "abc");
  assert.equal(escapeLike("50%"), "50\\%");
  assert.equal(escapeLike("foo_bar"), "foo\\_bar");
  assert.equal(escapeLike("x\\y"), "x\\\\y");
  assert.equal(escapeLike("100%_off"), "100\\%\\_off");
  assert.equal(escapeLike("a_b_c_"), "a\\_b\\_c\\_");
});

test("escapeLike: leaves PostgREST structural chars alone (caller handles them)", () => {
  // Commas, parens, quotes, dots: those matter to .or() grammar,
  // not to ilike. The lane never puts user text into .or() - it
  // runs two scoped queries. escapeLike only has to handle LIKE.
  assert.equal(escapeLike("a,b"), "a,b");
  assert.equal(escapeLike("a(b)"), "a(b)");
  assert.equal(escapeLike('"quoted"'), '"quoted"');
  assert.equal(escapeLike("foo.bar"), "foo.bar");
});

test("escapeLike: empty string", () => {
  assert.equal(escapeLike(""), "");
});
