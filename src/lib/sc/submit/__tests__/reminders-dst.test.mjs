// DST crossings handled by the OS tzdb via Intl.DateTimeFormat.
// Pin: 3 PM America/Chicago sees UTC 20:00 in CST + 20:00 in CDT
// (because our two cron hours are 20,21 and the LOCAL hour must
// equal 15; the handler short-circuits the other).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localPartsInZone,
  isFridayCentralHour,
  isMondayNineAtTz,
  mondayOfLocalDate,
  mondayOfPreviousWeek,
  reminderWeekStartFriday,
  reminderWeekStartMonday,
} from "../reminderScheduler.ts";

test("CST Friday Nov 13 2026 at 20:00 UTC == 14:00 CST (not the hour)", () => {
  const d = new Date("2026-11-13T20:00:00Z");
  assert.equal(isFridayCentralHour(d), false);
});

test("CST Friday Nov 13 2026 at 21:00 UTC == 15:00 CST (fires)", () => {
  const d = new Date("2026-11-13T21:00:00Z");
  assert.equal(isFridayCentralHour(d), true);
});

test("CDT Friday Jun 12 2026 at 20:00 UTC == 15:00 CDT (fires)", () => {
  const d = new Date("2026-06-12T20:00:00Z");
  assert.equal(isFridayCentralHour(d), true);
});

test("CDT Friday Jun 12 2026 at 21:00 UTC == 16:00 CDT (not the hour)", () => {
  const d = new Date("2026-06-12T21:00:00Z");
  assert.equal(isFridayCentralHour(d), false);
});

test("Monday 09:00 America/New_York during EST", () => {
  // Jan 12 2026 14:00 UTC == 9:00 EST
  assert.equal(isMondayNineAtTz(new Date("2026-01-12T14:00:00Z"), "America/New_York"), true);
  // And one hour off is not the window
  assert.equal(isMondayNineAtTz(new Date("2026-01-12T15:00:00Z"), "America/New_York"), false);
});

test("Monday 09:00 America/New_York during EDT", () => {
  // Jun 15 2026 13:00 UTC == 9:00 EDT
  assert.equal(isMondayNineAtTz(new Date("2026-06-15T13:00:00Z"), "America/New_York"), true);
});

test("Monday 09:00 America/Phoenix (never DST)", () => {
  // Jun 15 2026 16:00 UTC == 9:00 MST (Phoenix)
  assert.equal(isMondayNineAtTz(new Date("2026-06-15T16:00:00Z"), "America/Phoenix"), true);
  assert.equal(isMondayNineAtTz(new Date("2026-01-12T16:00:00Z"), "America/Phoenix"), true);
});

test("localPartsInZone gives weekday as a long name", () => {
  const p = localPartsInZone(new Date("2026-11-13T21:00:00Z"), "America/Chicago");
  assert.ok(p);
  assert.equal(p.weekday, "Friday");
});

test("mondayOfLocalDate returns the current Monday for a mid-week date", () => {
  // Wednesday 2026-11-18 in Chicago -> that week's Monday is 2026-11-16
  const p = localPartsInZone(new Date("2026-11-18T18:00:00Z"), "America/Chicago");
  assert.ok(p);
  assert.equal(mondayOfLocalDate(p), "2026-11-16");
});

test("mondayOfPreviousWeek returns last Monday for a Monday-9AM anchor", () => {
  // Monday 2026-11-23 09:00 CST -> last Monday is 2026-11-16
  const p = localPartsInZone(new Date("2026-11-23T15:00:00Z"), "America/Chicago");
  assert.ok(p);
  assert.equal(mondayOfPreviousWeek(p), "2026-11-16");
});

test("reminderWeekStartFriday returns this week's Monday", () => {
  assert.equal(
    reminderWeekStartFriday(new Date("2026-11-13T21:00:00Z"), "America/Chicago"),
    "2026-11-09",
  );
});

test("reminderWeekStartMonday returns last Monday", () => {
  assert.equal(
    reminderWeekStartMonday(new Date("2026-11-23T15:00:00Z"), "America/Chicago"),
    "2026-11-16",
  );
});
