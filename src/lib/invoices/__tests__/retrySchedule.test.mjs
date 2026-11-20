import { test } from "node:test";
import { strict as assert } from "node:assert";
import { decideRetry, waitAfterAttempt, GAVE_UP_AFTER_MS } from "../retrySchedule.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * 60 * 1000;

test("waitAfterAttempt: 1 2 3 -> 10 min", () => {
  assert.equal(waitAfterAttempt(1), 10 * MINUTE);
  assert.equal(waitAfterAttempt(2), 10 * MINUTE);
  assert.equal(waitAfterAttempt(3), 10 * MINUTE);
});

test("waitAfterAttempt: 4 -> 30 min", () => {
  assert.equal(waitAfterAttempt(4), 30 * MINUTE);
});

test("waitAfterAttempt: 5 and on -> 1 hour", () => {
  assert.equal(waitAfterAttempt(5), HOUR);
  assert.equal(waitAfterAttempt(6), HOUR);
  assert.equal(waitAfterAttempt(23), HOUR);
});

test("decideRetry: first failure at t0 -> schedule t0 + 10 min", () => {
  const t0 = new Date("2026-11-20T20:00:00Z");
  const r = decideRetry(t0, 1, t0);
  assert.equal(r.kind, "schedule");
  if (r.kind === "schedule") {
    assert.equal(r.nextAttemptAt.toISOString(), "2026-11-20T20:10:00.000Z");
  }
});

test("decideRetry: fourth failure -> schedule now + 30 min", () => {
  const t0 = new Date("2026-11-20T20:00:00Z");
  const now = new Date("2026-11-20T20:30:00Z");
  const r = decideRetry(t0, 4, now);
  assert.equal(r.kind, "schedule");
  if (r.kind === "schedule") {
    assert.equal(r.nextAttemptAt.toISOString(), "2026-11-20T21:00:00.000Z");
  }
});

test("decideRetry: fifth failure -> schedule now + 1 hour", () => {
  const t0 = new Date("2026-11-20T20:00:00Z");
  const now = new Date("2026-11-20T21:00:00Z");
  const r = decideRetry(t0, 5, now);
  assert.equal(r.kind, "schedule");
  if (r.kind === "schedule") {
    assert.equal(r.nextAttemptAt.toISOString(), "2026-11-20T22:00:00.000Z");
  }
});

test("decideRetry: a next attempt that would land >24h after the first try -> gave_up", () => {
  const t0 = new Date("2026-11-20T20:00:00Z");
  const now = new Date("2026-11-21T19:30:00Z"); // 23h30m after t0
  // Next wait (hourly) would land at 20:30 on the next day - 24h30m after t0.
  const r = decideRetry(t0, 6, now);
  assert.equal(r.kind, "gave_up");
});

test("decideRetry: exactly 24h cap boundary", () => {
  const t0 = new Date("2026-11-20T20:00:00Z");
  // A next attempt at exactly t0+24h must NOT be gave_up: the
  // cap is strictly greater-than.
  const now = new Date("2026-11-21T19:00:00Z"); // 23h after t0
  const r = decideRetry(t0, 6, now); // + 1h = 24h exactly
  assert.equal(r.kind, "schedule");
});

test("GAVE_UP_AFTER_MS is 24 hours", () => {
  assert.equal(GAVE_UP_AFTER_MS, 24 * 60 * 60 * 1000);
});
