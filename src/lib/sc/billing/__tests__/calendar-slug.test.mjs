// "TBR - FL" <-> "tbr-fl" round-trip.

import test from "node:test";
import assert from "node:assert/strict";
import { accountKeyToSlug, slugToAccountKey } from "../../calendar/slug.ts";

const KEYS = ["STL - FL", "TBJ - FL", "TBJ - NY", "TBR - FL", "CIN - AZ", "CIN - KY", "TXR - AZ"];

test("slug: every calendar key round-trips", () => {
  for (const k of KEYS) {
    const slug = accountKeyToSlug(k);
    assert.equal(slugToAccountKey(slug, KEYS), k, `round-trip failed for ${k}`);
  }
});

test("slug: Tampa is tbr-fl, not tbr--fl", () => {
  assert.equal(accountKeyToSlug("TBR - FL"), "tbr-fl");
});

test("slug: an unknown slug returns null", () => {
  assert.equal(slugToAccountKey("mlb-ny", KEYS), null);
});
