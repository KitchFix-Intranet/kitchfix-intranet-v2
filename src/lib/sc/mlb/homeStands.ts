// Group a season's schedule rows into "home stands" for the sidebar.
//
// Rule: group by `homestand_id` when every GAME row has it set. If
// any GAME row carries `homestand_id = null`, fall back to runs of
// consecutive home dates (GAME or EXHIBITION), stopping at an AWAY
// day or a gap in dates.
//
// The chosen mode is returned on each stand so callers can report it.

import type { ScheduleRow, HomeStand } from "./types";
import { dowOf } from "@/lib/sc/calendar/periodWindow";
import { formatGameTime } from "./gameMark";

export interface HomeStandsResult {
  stands: HomeStand[];
  groupedBy: "homestand_id" | "consecutive-home";
}

export function buildHomeStands(
  rows: readonly ScheduleRow[],
  timezone: string | null,
): HomeStandsResult {
  const homeOrExhib = rows.filter(
    (r) => r.day_type === "GAME" || r.day_type === "EXHIBITION",
  );
  // Determine mode: "homestand_id" only when every GAME row has one.
  const anyGameMissingId = homeOrExhib.some(
    (r) => r.day_type === "GAME" && !r.homestand_id,
  );
  const mode: "homestand_id" | "consecutive-home" = anyGameMissingId
    ? "consecutive-home"
    : "homestand_id";

  if (mode === "homestand_id") {
    // Group by homestand_id. Exhibition rows sit with the home
    // stand whose id they share; an exhibition row with no id is
    // appended to the run that is adjacent to it by date (rare /
    // currently not seen on these four accounts).
    const byId = new Map<string, ScheduleRow[]>();
    const idlessByDate: ScheduleRow[] = [];
    for (const r of homeOrExhib) {
      if (r.homestand_id) {
        const arr = byId.get(r.homestand_id);
        if (arr) arr.push(r);
        else byId.set(r.homestand_id, [r]);
      } else {
        idlessByDate.push(r);
      }
    }
    const stands: HomeStand[] = [];
    for (const [id, bucket] of byId.entries()) {
      bucket.sort((a, b) => a.service_date.localeCompare(b.service_date));
      stands.push(makeStand(id, bucket, "homestand_id", timezone));
    }
    // Rare: id-less exhibition rows go in on their own.
    for (const r of idlessByDate) {
      stands.push(makeStand(null, [r], "homestand_id", timezone));
    }
    stands.sort((a, b) => a.startIso.localeCompare(b.startIso));
    return { stands, groupedBy: "homestand_id" };
  }

  // Consecutive-home fallback.
  const byDate = homeOrExhib.slice().sort(
    (a, b) => a.service_date.localeCompare(b.service_date),
  );
  const stands: HomeStand[] = [];
  let run: ScheduleRow[] = [];
  for (const r of byDate) {
    if (run.length === 0) {
      run.push(r);
      continue;
    }
    const prev = run[run.length - 1];
    const prevDate = Date.parse(`${prev.service_date}T00:00:00Z`);
    const curDate = Date.parse(`${r.service_date}T00:00:00Z`);
    const diffDays = Math.round((curDate - prevDate) / 86400000);
    if (diffDays === 0 || diffDays === 1) {
      run.push(r);
    } else {
      stands.push(makeStand(null, run, "consecutive-home", timezone));
      run = [r];
    }
  }
  if (run.length) stands.push(makeStand(null, run, "consecutive-home", timezone));
  return { stands, groupedBy: "consecutive-home" };
}

function makeStand(
  id: string | null,
  rows: ScheduleRow[],
  groupedBy: "homestand_id" | "consecutive-home",
  timezone: string | null,
): HomeStand {
  const sorted = rows.slice().sort((a, b) => a.service_date.localeCompare(b.service_date));
  const games = sorted.map((r) => ({
    iso: r.service_date,
    dow: dowOf(r.service_date),
    opponent: r.opponent,
    timeLabel: formatGameTime(r.game_time, timezone),
    isDoubleheader: !!r.is_doubleheader,
    isExhibition: r.day_type === "EXHIBITION",
  }));
  const opponents: string[] = [];
  for (const g of games) if (!opponents.includes(g.opponent)) opponents.push(g.opponent);
  return {
    homestandId: id,
    groupedBy,
    startIso: sorted[0].service_date,
    endIso: sorted[sorted.length - 1].service_date,
    games,
    opponents,
  };
}
