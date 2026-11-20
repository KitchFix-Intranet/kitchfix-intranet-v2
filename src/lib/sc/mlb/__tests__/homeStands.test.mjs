// Home-stand grouper: homestand_id mode + consecutive-home fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHomeStands } from "../homeStands.ts";

function g(date, type, opp, id, time) {
  return {
    service_date: date,
    day_type: type,
    opponent: opp,
    homestand_id: id ?? null,
    game_time: time ?? null,
    day_night: null,
    is_doubleheader: false,
  };
}

test("groups by homestand_id when every GAME row has one", () => {
  const rows = [
    g("2026-07-05", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-06", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-07", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-10", "AWAY", "Harbor Hounds", null),
    g("2026-07-15", "GAME", "Prairie Jays", "HS-02"),
  ];
  const { stands, groupedBy } = buildHomeStands(rows, "America/New_York");
  assert.equal(groupedBy, "homestand_id");
  assert.equal(stands.length, 2);
  assert.equal(stands[0].games.length, 3);
  assert.equal(stands[1].games.length, 1);
});

test("falls back to consecutive-home when any GAME is missing an id", () => {
  const rows = [
    g("2026-07-05", "GAME", "Seaside Clams", null),  // missing id
    g("2026-07-06", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-07", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-10", "GAME", "Prairie Jays", "HS-02"),
  ];
  const { groupedBy, stands } = buildHomeStands(rows, "America/New_York");
  assert.equal(groupedBy, "consecutive-home");
  // Three contiguous dates then a gap of three, one more alone.
  assert.equal(stands.length, 2);
  assert.deepEqual(stands.map((s) => s.games.length), [3, 1]);
});

test("exhibition sits inside its homestand when it shares an id", () => {
  const rows = [
    g("2026-03-10", "EXHIBITION", "Prairie Jays", "HS-00"),
    g("2026-03-11", "GAME",       "Seaside Clams", "HS-00"),
  ];
  const { stands } = buildHomeStands(rows, "America/New_York");
  assert.equal(stands.length, 1);
  assert.equal(stands[0].games.length, 2);
  assert.ok(stands[0].games.some((g) => g.isExhibition));
});

test("consecutive-home: a one-day gap breaks the run", () => {
  const rows = [
    g("2026-07-01", "GAME", "Prairie Jays", null),
    g("2026-07-03", "GAME", "Prairie Jays", null),
  ];
  const { stands } = buildHomeStands(rows, "America/New_York");
  assert.equal(stands.length, 2);
});

test("opponents deduped in first-seen order", () => {
  const rows = [
    g("2026-07-05", "GAME", "Seaside Clams", "HS-01"),
    g("2026-07-06", "GAME", "Prairie Jays",  "HS-01"),
    g("2026-07-07", "GAME", "Seaside Clams", "HS-01"),
  ];
  const { stands } = buildHomeStands(rows, "America/New_York");
  assert.deepEqual(stands[0].opponents, ["Seaside Clams", "Prairie Jays"]);
});
