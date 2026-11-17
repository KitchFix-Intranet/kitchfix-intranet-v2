// buildDayToken: deterministic, sort-stable, sensitive to any
// value change, and agrees on the empty-day case.

import test from "node:test";
import assert from "node:assert/strict";
import { buildDayToken } from "../../dayActuals/dayToken.ts";

test("token: empty day yields a stable hash", () => {
  const a = buildDayToken([]);
  const b = buildDayToken([]);
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("token: same rows, different order, same hash", () => {
  const rows1 = [
    { service_id: "sv-b", actual_count: 1, updated_at: "2026-11-17T12:00:00Z" },
    { service_id: "sv-a", actual_count: 2, updated_at: "2026-11-17T12:00:00Z" },
  ];
  const rows2 = [
    { service_id: "sv-a", actual_count: 2, updated_at: "2026-11-17T12:00:00Z" },
    { service_id: "sv-b", actual_count: 1, updated_at: "2026-11-17T12:00:00Z" },
  ];
  assert.equal(buildDayToken(rows1), buildDayToken(rows2));
});

test("token: a different actual_count rotates", () => {
  const base = [{ service_id: "sv-a", actual_count: 1, updated_at: "2026-11-17T12:00:00Z" }];
  const changed = [{ service_id: "sv-a", actual_count: 2, updated_at: "2026-11-17T12:00:00Z" }];
  assert.notEqual(buildDayToken(base), buildDayToken(changed));
});

test("token: a different updated_at rotates", () => {
  const base = [{ service_id: "sv-a", actual_count: 1, updated_at: "2026-11-17T12:00:00Z" }];
  const changed = [{ service_id: "sv-a", actual_count: 1, updated_at: "2026-11-17T13:00:00Z" }];
  assert.notEqual(buildDayToken(base), buildDayToken(changed));
});

test("token: an added row rotates", () => {
  const base = [{ service_id: "sv-a", actual_count: 1, updated_at: "t" }];
  const grown = [
    { service_id: "sv-a", actual_count: 1, updated_at: "t" },
    { service_id: "sv-b", actual_count: 1, updated_at: "t" },
  ];
  assert.notEqual(buildDayToken(base), buildDayToken(grown));
});
