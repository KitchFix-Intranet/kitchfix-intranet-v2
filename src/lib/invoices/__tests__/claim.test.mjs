import { test } from "node:test";
import { strict as assert } from "node:assert";
import { canClaim, CLAIM_HOLD_MS } from "../claim.ts";

const NOW = new Date("2026-11-20T20:00:00Z");

test("canClaim: held + unclaimed -> true", () => {
  assert.equal(canClaim({ email_status: "held", claimed_until: null }, NOW), true);
});

test("canClaim: held + claim already past -> true", () => {
  assert.equal(canClaim({ email_status: "held", claimed_until: "2026-11-20T19:50:00Z" }, NOW), true);
});

test("canClaim: held + claim still in the future -> false", () => {
  assert.equal(canClaim({ email_status: "held", claimed_until: "2026-11-20T20:10:00Z" }, NOW), false);
});

test("canClaim: held + claim exactly now -> false (must be strictly past)", () => {
  // "<" not "<=": a claim that just landed is still held by its
  // owner. The runtime UPDATE uses `claimed_until.lt.<now>`.
  assert.equal(canClaim({ email_status: "held", claimed_until: NOW.toISOString() }, NOW), false);
});

test("canClaim: sent -> false whatever the claim", () => {
  assert.equal(canClaim({ email_status: "sent", claimed_until: null }, NOW), false);
  assert.equal(canClaim({ email_status: "sent", claimed_until: "2026-11-20T19:50:00Z" }, NOW), false);
});

test("canClaim: gave_up -> false", () => {
  assert.equal(canClaim({ email_status: "gave_up", claimed_until: null }, NOW), false);
});

test("canClaim: malformed claimed_until -> false (fail closed)", () => {
  assert.equal(canClaim({ email_status: "held", claimed_until: "not a date" }, NOW), false);
});

test("CLAIM_HOLD_MS is 5 minutes", () => {
  assert.equal(CLAIM_HOLD_MS, 5 * 60 * 1000);
});
