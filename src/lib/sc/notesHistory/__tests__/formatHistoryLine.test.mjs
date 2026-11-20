// Formatter cases + the two-second delete-group boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupHistory,
  describeFirstEntered,
  describeActualChange,
  describeActualDelete,
  describeDeleteGroup,
  DELETE_GROUP_WINDOW_MS,
} from "../formatHistoryLine.ts";

test("first_entered — resolved name", () => {
  assert.equal(
    describeFirstEntered({
      kind: "first_entered",
      authorDisplayName: "Jamie Rivera",
      at: "2026-11-15T14:00:00Z",
    }),
    "Entered by Jamie Rivera",
  );
});

test("first_entered — null author -> Someone", () => {
  assert.equal(
    describeFirstEntered({
      kind: "first_entered",
      authorDisplayName: null,
      at: "2026-11-15T14:00:00Z",
    }),
    "Entered by Someone",
  );
});

test("actual_change — non-zero new count", () => {
  assert.equal(
    describeActualChange({
      kind: "actual_change",
      serviceId: "svc-1",
      serviceName: "Lunch",
      oldCount: 90,
      newCount: 84,
      authorDisplayName: "Jamie Rivera",
      at: "2026-11-15T15:00:00Z",
    }),
    "Changed by Jamie Rivera: Lunch 90 to 84",
  );
});

test("actual_change — new count 0 reads as Cleared", () => {
  assert.equal(
    describeActualChange({
      kind: "actual_change",
      serviceId: "svc-1",
      serviceName: "Dinner",
      oldCount: 45,
      newCount: 0,
      authorDisplayName: null,
      at: "2026-11-15T15:30:00Z",
    }),
    "Cleared by Someone: Dinner (was 45)",
  );
});

test("actual_delete — resets a service", () => {
  assert.equal(
    describeActualDelete({
      kind: "actual_delete",
      serviceId: "svc-2",
      serviceName: "Breakfast",
      oldCount: 50,
      authorDisplayName: "Jamie Rivera",
      at: "2026-11-15T15:30:00Z",
    }),
    "Reset by Jamie Rivera: Breakfast (was 50)",
  );
});

test("describeDeleteGroup pluralises", () => {
  assert.equal(
    describeDeleteGroup({
      kind: "actual_delete_group",
      services: [
        { serviceId: "a", serviceName: "A", oldCount: 1 },
        { serviceId: "b", serviceName: "B", oldCount: 2 },
      ],
      authorDisplayName: "Jamie Rivera",
      firstAt: "2026-11-15T15:30:00.000Z",
      lastAt: "2026-11-15T15:30:00.500Z",
    }),
    "Reset by Jamie Rivera: 2 services cleared",
  );
});

// ── groupHistory: the two-second boundary ─────────────────────────

function del(iso, author, svc) {
  return {
    kind: "actual_delete",
    serviceId: svc,
    serviceName: svc,
    oldCount: 1,
    authorDisplayName: author,
    at: iso,
  };
}

test("groupHistory: two deletes 1s apart by same author -> grouped", () => {
  const items = groupHistory([
    del("2026-11-15T15:30:01Z", "Jamie Rivera", "A"),
    del("2026-11-15T15:30:00Z", "Jamie Rivera", "B"),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "actual_delete_group");
  assert.equal(items[0].services.length, 2);
});

test("groupHistory: deletes exactly 2s apart -> grouped", () => {
  const dt = DELETE_GROUP_WINDOW_MS;
  const items = groupHistory([
    del(new Date(1_700_000_000_000 + dt).toISOString(), "Jamie Rivera", "A"),
    del(new Date(1_700_000_000_000).toISOString(), "Jamie Rivera", "B"),
  ]);
  assert.equal(items.length, 1);
});

test("groupHistory: deletes > 2s apart -> separate", () => {
  const items = groupHistory([
    del("2026-11-15T15:30:03Z", "Jamie Rivera", "A"),
    del("2026-11-15T15:30:00Z", "Jamie Rivera", "B"),
  ]);
  assert.equal(items.length, 2);
});

test("groupHistory: different authors -> separate", () => {
  const items = groupHistory([
    del("2026-11-15T15:30:01Z", "Jamie Rivera", "A"),
    del("2026-11-15T15:30:00Z", "Pat Avila", "B"),
  ]);
  assert.equal(items.length, 2);
});

test("groupHistory: a non-delete between deletes breaks the group", () => {
  const items = groupHistory([
    del("2026-11-15T15:30:02Z", "Jamie Rivera", "A"),
    {
      kind: "actual_change",
      serviceId: "X", serviceName: "X",
      oldCount: 1, newCount: 2,
      authorDisplayName: "Jamie Rivera",
      at: "2026-11-15T15:30:01Z",
    },
    del("2026-11-15T15:30:00Z", "Jamie Rivera", "B"),
  ]);
  assert.equal(items.length, 3);
});

test("groupHistory: a single delete is not wrapped", () => {
  const items = groupHistory([
    del("2026-11-15T15:30:00Z", "Jamie Rivera", "A"),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "actual_delete");
});
