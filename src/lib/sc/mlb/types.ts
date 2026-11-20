// Big-league clubhouse calendar read model.
//
// One source: sc_homestand_schedule. Never sc_day_metadata.game_type
// on this page (it disagrees with the schedule on away days). The
// table ends Sep 27, 2026 and has nothing for 2027; a season-over
// state is the normal landing until the 2027 load.

export type ScheduleDayType = "GAME" | "AWAY" | "EXHIBITION";
// Other day_type values exist in v1 for MiLB (PREP / OPEN / CLOSE /
// CLEAN). None are present for the four MLB accounts. We draw only
// the three above here; anything else is ignored.

export interface ScheduleRow {
  service_date: string;        // YYYY-MM-DD
  day_type: ScheduleDayType;   // narrowed to the three we draw
  opponent: string;
  homestand_id: string | null; // null on AWAY per table convention
  game_time: string | null;    // timestamptz as text; ISO
  day_night: "day" | "night" | null;
  is_doubleheader: boolean;
}

// One game as rendered on a cell. Opponent kept verbatim as it
// sits in the DB; display names are not translated.
export interface GameMark {
  kind: "home" | "away" | "exhibition";
  opponent: string;
  // 12-hour label in the account's own time zone ("7:05 PM").
  // Only set for home + exhibition; null on away rows.
  timeLabel: string | null;
  isDoubleheader: boolean;
}

export interface MonthCell {
  iso: string;         // YYYY-MM-DD
  dayNum: number;      // 1..31
  isOutOfMonth: boolean;
  isToday: boolean;
  games: GameMark[];   // 0..N (doubleheader = 2)
}

export interface HomeStand {
  homestandId: string | null;    // null when grouped by consecutive-date run
  groupedBy: "homestand_id" | "consecutive-home";
  startIso: string;
  endIso: string;
  games: Array<{
    iso: string;
    dow: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Monday
    opponent: string;
    timeLabel: string | null;
    isDoubleheader: boolean;
    isExhibition: boolean;
  }>;
  opponents: string[]; // de-duped in first-seen order
}

export interface MlbMonth {
  year: number;
  monthIdx: number;      // 0..11
  monthLabel: string;    // "November 2026"
  weeksCells: MonthCell[][]; // 5 or 6 rows of 7 cells
  homeStands: HomeStand[]; // stands overlapping this month
  homeCountInMonth: number;
  awayCountInMonth: number;
}

export interface MlbCalendarView {
  site: {
    accountKey: string;
    slug: string;
    name: string;
    region: string | null;
    timezone: string | null;
  };
  // Band facts across the whole season loaded (not just the month).
  seasonHomeGames: number;
  seasonHomeStands: number;
  firstGameIso: string | null;
  lastGameIso: string | null;
  seasonOver: boolean;
  // The month currently on show.
  month: MlbMonth;
  // Prev/Next month hrefs; null when the end of the loaded span.
  prevHref: string | null;
  nextHref: string | null;
  minMonthIdx: number;
  maxMonthIdx: number;
  // Chicago-stable site today.
  today: string;
}
