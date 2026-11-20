// One case per day_type value + a time-zone rendering case.
// Opponent names here are invented; the public-repo rule bans
// real client names inside tests / fixtures / docs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gameMarkFromRow, formatGameTime } from "../gameMark.ts";

test("GAME -> home mark with time", () => {
  const m = gameMarkFromRow(
    {
      service_date: "2026-07-05",
      day_type: "GAME",
      opponent: "Seaside Clams",
      homestand_id: "HS-01",
      game_time: "2026-07-05T23:05:00Z",   // 7:05 PM Eastern (UTC-4 in July)
      day_night: "night",
      is_doubleheader: false,
    },
    "America/New_York",
  );
  assert.ok(m);
  assert.equal(m.kind, "home");
  assert.equal(m.opponent, "Seaside Clams");
  assert.equal(m.timeLabel, "7:05 PM");
  assert.equal(m.isDoubleheader, false);
});

test("AWAY -> away mark with no time", () => {
  const m = gameMarkFromRow(
    {
      service_date: "2026-07-08",
      day_type: "AWAY",
      opponent: "Harbor Hounds",
      homestand_id: null,
      game_time: null,
      day_night: null,
      is_doubleheader: false,
    },
    "America/New_York",
  );
  assert.ok(m);
  assert.equal(m.kind, "away");
  assert.equal(m.opponent, "Harbor Hounds");
  assert.equal(m.timeLabel, null);
});

test("EXHIBITION -> exhibition mark; time may be null", () => {
  const m = gameMarkFromRow(
    {
      service_date: "2026-03-14",
      day_type: "EXHIBITION",
      opponent: "Prairie Jays",
      homestand_id: null,
      game_time: null,
      day_night: null,
      is_doubleheader: false,
    },
    "America/Chicago",
  );
  assert.ok(m);
  assert.equal(m.kind, "exhibition");
  assert.equal(m.opponent, "Prairie Jays");
  assert.equal(m.timeLabel, null);
});

test("unknown day_type -> null (not drawn)", () => {
  // ScheduleDayType is narrowed before reaching this function, but
  // as a type-erased runtime check the switch returns undefined on
  // anything else. Guard by casting.
  // @ts-expect-error — testing a runtime branch outside the type
  const m = gameMarkFromRow(
    {
      service_date: "2026-04-01",
      day_type: "PREP",
      opponent: "",
      homestand_id: null,
      game_time: null,
      day_night: null,
      is_doubleheader: false,
    },
    "America/New_York",
  );
  // The switch falls through so TypeScript inference gives undefined;
  // the production call-site filters day_type first. At runtime the
  // return is undefined, which is "falsy" for our purposes.
  assert.ok(!m);
});

test("formatGameTime renders in the account's own timezone", () => {
  const iso = "2026-07-05T23:05:00Z";
  assert.equal(formatGameTime(iso, "America/New_York"), "7:05 PM");
  assert.equal(formatGameTime(iso, "America/Chicago"), "6:05 PM");
  assert.equal(formatGameTime(iso, "America/Phoenix"), "4:05 PM");
});

test("formatGameTime returns null on null or unparseable input", () => {
  assert.equal(formatGameTime(null, "America/New_York"), null);
  assert.equal(formatGameTime("", "America/New_York"), null);
  assert.equal(formatGameTime("not a date", "America/New_York"), null);
});
