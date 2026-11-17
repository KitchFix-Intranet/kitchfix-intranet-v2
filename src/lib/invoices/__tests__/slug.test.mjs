import { test } from "node:test";
import { strict as assert } from "node:assert";
import { accountKeyToSlug, slugToAccountKey } from "../slug.ts";

const NINE_KEYS = [
  "STL - MO",
  "STL - FL",
  "TBR - FL",
  "TBJ - FL",
  "CIN - AZ",
  "TXR - AZ",
  "CIN - OH",
  "TXR - TX - H",
  "TXR - TX - V",
];

const ELEVEN_KEYS = [
  ...NINE_KEYS,
  "CIN - KY",
  "TBJ - NY",
];

test("accountKeyToSlug: nine site keys round-trip", () => {
  for (const k of NINE_KEYS) {
    const slug = accountKeyToSlug(k);
    const back = slugToAccountKey(slug, NINE_KEYS);
    assert.equal(back, k, `round-trip failed for ${k} via ${slug}`);
  }
});

test("accountKeyToSlug: eleven in-scope keys all unique", () => {
  const slugs = new Set(ELEVEN_KEYS.map(accountKeyToSlug));
  assert.equal(slugs.size, ELEVEN_KEYS.length, "every in-scope key has a distinct slug");
});

test("accountKeyToSlug: three-segment key maps to three-segment slug", () => {
  assert.equal(accountKeyToSlug("TXR - TX - H"), "txr-tx-h");
  assert.equal(accountKeyToSlug("TXR - TX - V"), "txr-tx-v");
});

test("slugToAccountKey: case-insensitive match against the scope list", () => {
  assert.equal(slugToAccountKey("TBR-FL", NINE_KEYS), "TBR - FL");
  assert.equal(slugToAccountKey("tbr-fl", NINE_KEYS), "TBR - FL");
});

test("slugToAccountKey: unknown slug returns null", () => {
  assert.equal(slugToAccountKey("abc-def", NINE_KEYS), null);
  assert.equal(slugToAccountKey("", NINE_KEYS), null);
});

test("slugToAccountKey: slug outside the passed scope list returns null", () => {
  assert.equal(slugToAccountKey("txr-tx-h", ["STL - FL"]), null);
});
