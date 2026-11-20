// Sites board read model. Four groups, in order of need, with the
// per-site row shape and the band's computed headline.

import type { DayStateCode, SiteInfo, HomeGameMark } from "@/lib/sc/calendar/types";

export type SiteRowKind =
  // Needs someone (office + director):
  | "push"      // submitted in V2 with push_gave_up_at (office only key)
  | "late"      // week ended, no submit, exempt did not fire
  | "stuck"     // week has a billed line with no invoice line / no price
  | "flag"      // one or more days flagged for a fix
  // This week:
  | "open"      // unit still open, work to go
  | "entered"   // unit still open, every projected answered
  | "ready"     // unit ended + ready to submit (post-check path)
  // Submitted:
  | "sent"      // submitted + pushed OR not billed
  | "noinv"     // submitted + not billed through the calendar
  // Not serving:
  | "off"       // no projections this week
  | "over";     // never again (season over / future off) — reserved,
                // not emitted today without a schedule reader

// Four plain headings, in brief order.
export const BUCKET_ORDER = ["need", "week", "sent", "off"] as const;
export type BucketKey = (typeof BUCKET_ORDER)[number];

// Which rows belong under each heading.
export const BUCKETS: Record<BucketKey, { label: string; kinds: SiteRowKind[] }> = {
  need: { label: "Needs someone", kinds: ["push", "late", "stuck", "flag"] },
  week: { label: "This week",     kinds: ["open", "entered", "ready"] },
  sent: { label: "Submitted",     kinds: ["sent", "noinv"] },
  off:  { label: "Not serving",   kinds: ["off", "over"] },
};

// Within a bucket, rows are sorted by rank below (lower = first).
export const KIND_RANK: Record<SiteRowKind, number> = {
  push: 0,
  late: 1,
  stuck: 2,
  flag: 3,
  open: 10,
  entered: 11,
  ready: 12,
  sent: 20,
  noinv: 21,
  off: 30,
  over: 31,
};

// The seven-square day states shown on each row's mini. Reuses the
// calendar's DayStateCode so the state machine stays one.
export interface BoardSquare {
  iso: string;
  state: DayStateCode;
  isToday: boolean;
  isHome: boolean;
}

export interface BoardRow {
  site: SiteInfo;
  leaderName: string | null;    // "No site leader yet" when null
  kind: SiteRowKind;
  word: string;                 // state word for the row
  tone: "good" | "navy" | "warn" | "muted" | "block";
  icon: string;                 // icon name for the state
  sub: string | null;           // optional sub-line under the state
  squares: BoardSquare[];       // seven
  meals: number | null;         // week's meal total; null for no-service
  shortDollars: string | null;  // nearest hundred; null when not billed or no entry
  // Destination URL for the whole-row Link:
  //   - a 'push' row goes to /service/review?site=&week=
  //   - every other row goes to /service?site=
  goHref: string;
  goLabel: "Open calendar" | "See the push";
}

export interface BigLeagueRow {
  // Big-league clubhouses sit in their own sub-card. Calendar-only;
  // they carry no state word and no meals.
  accountKey: string;
  slug: string;
  name: string;
  region: string | null;
  leaderName: string | null;
  homeGames: number;   // total HOME rows for the season (all dates)
  seasonOver: boolean; // last HOME game < site today
  // Fix 4 (train 4b): the last HOME game only. AWAY and EXHIBITION
  // rows are not candidates. Null when no GAME row is loaded yet.
  lastHomeGameIso: string | null;
  goHref: string;
}

export interface SitesBoardView {
  weekStart: string;           // Monday of the central today
  weekEndIso: string;          // Sunday of weekStart
  showRegionFilter: boolean;
  region: "all" | "East" | "West";
  // The band's computed headline and kick.
  band: {
    eyebrow: string;
    title: string;
    kick: string;
    totalMealsThisWeek: number | null;
    submittedN: number;
    submittedOf: number;
  };
  weekLabel: string;           // "Week of Nov 16 - 22"
  // Rows grouped by key, in bucket order; empty buckets are kept out.
  buckets: Array<{ key: BucketKey; label: string; rows: BoardRow[] }>;
  // Big-league clubhouses in their own card, ordered by name.
  bigLeague: BigLeagueRow[];
  // True when the office viewer is seeing this board (gates "push" rows).
  isOfficeViewer: boolean;
}

// Also carry the 7 day-of-week letters so the row header renders.
export const DOW_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;

// The home/away mark shape from calendar (re-exported for board).
export type { HomeGameMark };
