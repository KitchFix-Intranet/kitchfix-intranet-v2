// Pure conversion from a sc_homestand_schedule row to the
// draw-on-cell shape. Four values of day_type are the ones we draw:
//   GAME       -> home   (navy cell, "vs <opponent>", time in zone)
//   AWAY       -> away   (muted cell, "at <opponent>", no time)
//   EXHIBITION -> exhibition (sky cell, "vs <opponent>", time + "exhibition")
// Anything else (PREP/OPEN/CLOSE/CLEAN) yields null — ignored.
//
// Time formatting lives below; game_time is a timestamptz text with
// a zone, and we always re-express it in the account's own timezone,
// never the server's.

import type { ScheduleRow, GameMark } from "./types";

export function gameMarkFromRow(row: ScheduleRow, timezone: string | null): GameMark | null {
  switch (row.day_type) {
    case "GAME":
      return {
        kind: "home",
        opponent: row.opponent,
        timeLabel: formatGameTime(row.game_time, timezone),
        isDoubleheader: !!row.is_doubleheader,
      };
    case "AWAY":
      return {
        kind: "away",
        opponent: row.opponent,
        timeLabel: null,
        isDoubleheader: !!row.is_doubleheader,
      };
    case "EXHIBITION":
      return {
        kind: "exhibition",
        opponent: row.opponent,
        timeLabel: formatGameTime(row.game_time, timezone),
        isDoubleheader: !!row.is_doubleheader,
      };
  }
}

// "7:05 PM" style, in the account's own zone. Returns null when the
// input is null or not parseable; falls back to America/New_York if
// the account has no timezone column set.
export function formatGameTime(iso: string | null, timezone: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const tz = timezone || "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(t));
  const h = parts.find((p) => p.type === "hour")?.value ?? "";
  const m = parts.find((p) => p.type === "minute")?.value ?? "";
  const ap = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  if (!h || !m || !ap) return null;
  return `${h}:${m} ${ap.toUpperCase()}`;
}
