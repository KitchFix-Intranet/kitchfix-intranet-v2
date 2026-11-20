// Big-league clubhouse calendar loader. One source table:
// sc_homestand_schedule. One wave of reads.
//
// Round trips:
//   1. rpc sc_site_today(p_account_key)
//   2. accounts row (name, region, timezone, level, active)
//   3. sc_homestand_schedule, all rows for the account (<= ~200 today)

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountLite } from "@/lib/sc/calendar/types";
import { accountKeyToSlug } from "@/lib/sc/calendar/slug";
import { addDaysIso } from "@/lib/sc/calendar/periodWindow";
import { gameMarkFromRow } from "./gameMark";
import { buildHomeStands } from "./homeStands";
import type {
  MlbCalendarView,
  MlbMonth,
  MonthCell,
  ScheduleRow,
  ScheduleDayType,
  GameMark,
} from "./types";

const MONTH_LABELS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const SCHEDULE_PAGE_CAP = 1000;

const DAY_TYPES_WE_DRAW: readonly ScheduleDayType[] = ["GAME", "AWAY", "EXHIBITION"];

export interface LoadMlbInput {
  sb: SupabaseClient;
  account: AccountLite;    // already verified level='MLB' and in scope
  monthParam: number | null; // 0..11; null = default for season
  basePath: string;          // "/service/mlb"
}

export async function loadMlbCalendar(input: LoadMlbInput): Promise<MlbCalendarView> {
  const { sb, account, monthParam, basePath } = input;
  const accountKey = account.team_key;

  const [siteTodayQ, schedQ] = await Promise.all([
    sb.rpc("sc_site_today", { p_account_key: accountKey }),
    sb.from("sc_homestand_schedule")
      .select("service_date, day_type, opponent, homestand_id, game_time, day_night, is_doubleheader", { count: "exact" })
      .eq("account_key", accountKey)
      .order("service_date", { ascending: true })
      .limit(SCHEDULE_PAGE_CAP),
  ]);

  if (siteTodayQ.error) throw new Error(`sc_site_today(${accountKey}): ${siteTodayQ.error.message}`);
  const today = String(siteTodayQ.data);

  if (schedQ.error) throw new Error(`sc_homestand_schedule(${accountKey}): ${schedQ.error.message}`);
  const count = schedQ.count ?? 0;
  const rawRows = (schedQ.data ?? []) as Array<{
    service_date: string;
    day_type: string;
    opponent: string;
    homestand_id: string | null;
    game_time: string | null;
    day_night: string | null;
    is_doubleheader: boolean | null;
  }>;
  if (rawRows.length !== count) {
    throw new Error(`sc_homestand_schedule paging: expected ${count} rows, got ${rawRows.length} for ${accountKey}`);
  }
  if (rawRows.length >= SCHEDULE_PAGE_CAP) {
    throw new Error(`sc_homestand_schedule hit the ${SCHEDULE_PAGE_CAP}-row cap for ${accountKey}; page it`);
  }

  // Narrow to the three day_types we draw; drop MiLB-only phase rows.
  const rows: ScheduleRow[] = rawRows
    .filter((r) => (DAY_TYPES_WE_DRAW as readonly string[]).includes(r.day_type))
    .map((r) => ({
      service_date: r.service_date,
      day_type: r.day_type as ScheduleDayType,
      opponent: r.opponent,
      homestand_id: r.homestand_id,
      game_time: r.game_time,
      day_night: r.day_night === "day" ? "day" : r.day_night === "night" ? "night" : null,
      is_doubleheader: !!r.is_doubleheader,
    }));

  const home = rows.filter((r) => r.day_type === "GAME");
  const away = rows.filter((r) => r.day_type === "AWAY");
  const exhib = rows.filter((r) => r.day_type === "EXHIBITION");
  const seasonHomeGames = home.length;
  const firstGameIso = rows.length ? rows[0].service_date : null;
  const lastGameIso = rows.length ? rows[rows.length - 1].service_date : null;
  const seasonOver = !!lastGameIso && lastGameIso < today;

  // Build stands for the whole season; the month card lists stands
  // that overlap the chosen month.
  const { stands } = buildHomeStands(rows, account.timezone);
  const seasonHomeStands = stands.length;

  // Pick the month to show.
  // Preference: the param, if valid and in the loaded span.
  // Else: a month inside the season that contains today.
  // Else: the first month of the season (pre-season)
  //       OR the month of the last game (post-season).
  // Else (no rows at all): the month of today.
  const monthsLoaded = uniqueMonths(rows); // sorted asc
  const minMonthIdx = monthsLoaded.length ? Math.min(...monthsLoaded) : todayMonth(today);
  const maxMonthIdx = monthsLoaded.length ? Math.max(...monthsLoaded) : todayMonth(today);

  const todayM = todayMonth(today);
  let monthIdx: number;
  if (monthParam != null && monthParam >= 0 && monthParam <= 11 && monthsLoaded.includes(monthParam)) {
    monthIdx = monthParam;
  } else if (firstGameIso && lastGameIso && today >= firstGameIso && today <= lastGameIso) {
    monthIdx = todayM;
  } else if (seasonOver && lastGameIso) {
    monthIdx = Number(lastGameIso.slice(5, 7)) - 1;
  } else if (firstGameIso) {
    monthIdx = Number(firstGameIso.slice(5, 7)) - 1;
  } else {
    monthIdx = todayM;
  }
  const year = yearOfReference(firstGameIso, lastGameIso, today);

  const month = buildMonth(year, monthIdx, rows, today, account.timezone, stands);

  const prevMonthsLoaded = monthsLoaded.filter((m) => m < monthIdx);
  const nextMonthsLoaded = monthsLoaded.filter((m) => m > monthIdx);
  const slug = accountKeyToSlug(accountKey);
  const prevHref = prevMonthsLoaded.length
    ? `${basePath}?site=${slug}&m=${prevMonthsLoaded[prevMonthsLoaded.length - 1]}`
    : null;
  const nextHref = nextMonthsLoaded.length
    ? `${basePath}?site=${slug}&m=${nextMonthsLoaded[0]}`
    : null;

  void away; void exhib; // retained in case future kick copy wants them

  return {
    site: {
      accountKey,
      slug,
      name: account.name ?? accountKey,
      region: account.region,
      timezone: account.timezone,
    },
    seasonHomeGames,
    seasonHomeStands,
    firstGameIso,
    lastGameIso,
    seasonOver,
    month,
    prevHref,
    nextHref,
    minMonthIdx,
    maxMonthIdx,
    today,
  };
}

// Build a 7-column grid for a calendar month, Monday-first, with
// out-of-month leading + trailing cells.
function buildMonth(
  year: number,
  monthIdx: number,
  rows: readonly ScheduleRow[],
  today: string,
  timezone: string | null,
  stands: ReturnType<typeof buildHomeStands>["stands"],
): MlbMonth {
  // Map rows by ISO date for this month's cells.
  const rowsByDate = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    const arr = rowsByDate.get(r.service_date);
    if (arr) arr.push(r); else rowsByDate.set(r.service_date, [r]);
  }

  const first = new Date(Date.UTC(year, monthIdx, 1));
  // Leading days to reach Monday = 0.
  const jsDow = first.getUTCDay();          // 0 Sun ... 6 Sat
  const leading = (jsDow + 6) % 7;          // 0 = Monday
  const dim = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const totalCells = Math.ceil((leading + dim) / 7) * 7;

  const cells: MonthCell[] = [];
  for (let c = 0; c < totalCells; c++) {
    const d = new Date(Date.UTC(year, monthIdx, 1 - leading + c));
    const iso = d.toISOString().slice(0, 10);
    const out = d.getUTCMonth() !== monthIdx;
    const dayRows = rowsByDate.get(iso) ?? [];
    const games: GameMark[] = [];
    for (const r of dayRows) {
      const m = gameMarkFromRow(r, timezone);
      if (m) games.push(m);
    }
    cells.push({
      iso,
      dayNum: d.getUTCDate(),
      isOutOfMonth: out,
      isToday: iso === today,
      games,
    });
  }

  // Slice into rows of seven.
  const weeksCells: MonthCell[][] = [];
  for (let i = 0; i < totalCells; i += 7) {
    weeksCells.push(cells.slice(i, i + 7));
  }

  // Count home + away within this month (narrowing from the
  // rows-by-date map, scoped to in-month cells).
  const mm = String(monthIdx + 1).padStart(2, "0");
  let homeCountInMonth = 0;
  let awayCountInMonth = 0;
  for (const r of rows) {
    if (r.service_date.slice(5, 7) !== mm) continue;
    if (r.day_type === "GAME" || r.day_type === "EXHIBITION") homeCountInMonth += 1;
    else if (r.day_type === "AWAY") awayCountInMonth += 1;
  }

  // Stands whose span overlaps the month.
  const monthStartIso = `${year}-${mm}-01`;
  const monthEndIso = `${year}-${mm}-${String(dim).padStart(2, "0")}`;
  const homeStandsInMonth = stands.filter(
    (s) => s.endIso >= monthStartIso && s.startIso <= monthEndIso,
  );

  return {
    year,
    monthIdx,
    monthLabel: `${MONTH_LABELS[monthIdx]} ${year}`,
    weeksCells,
    homeStands: homeStandsInMonth,
    homeCountInMonth,
    awayCountInMonth,
  };
}

// Helpers.

function uniqueMonths(rows: readonly ScheduleRow[]): number[] {
  const s = new Set<number>();
  for (const r of rows) s.add(Number(r.service_date.slice(5, 7)) - 1);
  return Array.from(s).sort((a, b) => a - b);
}

function todayMonth(iso: string): number {
  return Number(iso.slice(5, 7)) - 1;
}

function yearOfReference(firstIso: string | null, lastIso: string | null, today: string): number {
  // The season loaded so far ends in 2026; use the last-game year
  // when one exists, else today's year.
  if (lastIso) return Number(lastIso.slice(0, 4));
  if (firstIso) return Number(firstIso.slice(0, 4));
  return Number(today.slice(0, 4));
}

// Keep exported so the page can re-use addDaysIso without importing
// the calendar module directly in a type-only path.
export { addDaysIso };
