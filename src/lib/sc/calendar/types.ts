// Calendar read model - shapes only.
//
// Four kinds of file sit next to this one:
//   dayState.ts   - a day's word, tone and icon from its numbers
//   weekState.ts  - a week's word, tone and icon from its days + any submit row
//   billable.ts   - a week's short dollars and the "Not billed" branch
//   accessList.ts - which calendar accounts a viewer sees (RD -> corp -> salaried)
//   slug.ts       - "TBR - FL" <-> "tbr-fl"
//   periodWindow.ts - 28-day Monday-first layout from fiscal_periods
//   load.ts       - the one loader, all the DB reads in one place
//   inScopeAdapter.ts - a thin in-memory supa shape so resolveFinalizeReviewSpan
//                       can run from already-loaded rows (zero extra network)
//
// Nothing here holds an address. `submittedBy` is deliberately absent
// from WeekView: `sc_week_finalize.finalized_by` is a work email, and
// no address leaves the server.

export type DayTone = "good" | "navy" | "warn" | "muted" | "block";

export type DayStateCode =
  | "needs_fix"       // review_status = 'flagged'
  | "submitted"       // entered or not-served, inside a submitted span
  | "closed"          // entered, period closed, no submitted span over it
  | "entered"         // every projected line has an actuals row above 0
  | "part_entered"    // some actuals but a projected line has no row
  | "not_served"      // actuals rows exist, none above 0, something was projected
  | "no_actuals"      // projected, but locked by a submit or a closed period
  | "needs_actuals"   // projected, its unit has ended, nothing entered yet
  | "projected"       // projected, nothing entered, unit still open
  | "no_service";     // nothing projected, nothing entered

export type WeekStateCode =
  | "submitted"
  | "push_failed"     // only shown to corporate viewers; everyone else reads submitted
  | "not_serving"
  | "period_closed"
  | "still_open"
  | "to_enter"        // open week, work still to do
  | "entered";        // open week, every projected line answered

export type IconName =
  | "lock"
  | "check"
  | "pencil"
  | "ban"
  | "minus"
  | "clock"
  | "flag"
  | "circle-dashed"
  | "triangle-alert"
  | "send"
  | "house";

export interface ViewerLite {
  worker_id: string;
  display_name: string;
  role: "corporate" | "regional_director" | "site_leader" | "site_manager" | null;
  is_corp: boolean;
  is_regional_director: boolean;
  is_salaried: boolean;
  region: string | null;
  account_key: string;
  previewOf: { worker_id: string; display_name: string } | null;
}

export interface SiteNavItem {
  accountKey: string;
  slug: string;
  name: string;         // accounts.name, or the key as a fallback
  region: string | null;
}

export interface SiteInfo {
  accountKey: string;
  slug: string;
  name: string;
  region: string | null;
  level: string | null;
  isBilled: boolean;
  cadence: "weekly" | "biweekly";
  timezone: string | null;
}

// A home game (DAY or NIGHT) at CIN - KY or TBJ - NY. The five
// complexes do not use game_type at all (checked Nov 16, 2026). A
// game_time of null means the time is not on record.
export interface HomeGameMark {
  kind: "day" | "night";
  time: string | null;
}

export interface DayView {
  iso: string;                // YYYY-MM-DD, Chicago-stable
  dow: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Monday
  isToday: boolean;
  // Meal number the cell shows. null when there is nothing to show.
  // Blank-is-not-zero (pin 3): a typed 0 still has an actuals row, so
  // meals = 0 lands here as a real 0 only when every line is 0.
  meals: number | null;
  projectedMeals: number | null;
  // "every projected line answered with 0": the day was marked not
  // served. `meals` is 0 then (not null).
  marked: boolean;
  // Any projected line that has no actuals row (within an entered day).
  hasBlankLine: boolean;
  home: HomeGameMark | null;
  state: DayStateCode;
  word: string;               // "Entered", "Submitted", etc.
  tone: DayTone;
  icon: IconName;
}

export interface WeekView {
  weekStart: string;          // Monday ISO
  dates: string[];            // seven ISO dates, Monday first
  days: DayView[];
  state: WeekStateCode;
  word: string;
  tone: DayTone;
  icon: IconName;
  meals: number | null;
  billableCents: number | null;  // raw cents; null when not billed or
                                 // no entered days. Rounding to the
                                 // short display lives in billable.ts.
  hasEntered: boolean;
  hasService: boolean;
  submittedAt: string | null;  // timestamptz; shown as "Submitted Fri, Nov 13"
  // The camp phase that covers this week's Monday, read from
  // sc_phase_calendar. Shown in the week column while the week is open.
  phase: string | null;
}

export interface PeriodView {
  fiscalYear: number;
  periodNo: number;
  startIso: string;
  endIso: string;
  weeks: WeekView[];          // exactly 4 for 2026 + 2027 periods
  isClosed: boolean;
  allSubmitted: boolean;
}

export interface YearSquare {
  iso: string;
  meals: number;              // 0 when blank-no-service, or when every entered
                              // line is a non-meal unit (pans/each/days)
  state: DayStateCode;
  isToday: boolean;
  isHome: boolean;
  // "Any line above 0": the day has at least one actuals row above zero,
  // whether or not it counts in meals. A not-served day (every projected
  // line answered with 0) does NOT set this.
  hasAnyEnteredValue: boolean;
}

export interface YearPeriodCard {
  periodNo: number;
  startIso: string;
  endIso: string;
  squares: YearSquare[];      // 28 of them
  meals: number;              // sum of entered-day meals in the period
  needsActualsCount: number;
  isCurrent: boolean;
  isClosed: boolean;
}

export interface CalendarView {
  viewer: ViewerLite;
  site: SiteInfo;
  today: string;              // sc_site_today(account_key), Chicago-stable
  period: PeriodView;
  year: {
    fiscalYear: number;
    cards: YearPeriodCard[];
    totals: { entered: number; meals: number };
  };
  // For a corporate viewer only: the week_start of a submitted row
  // whose push to QuickBooks did not land, in this unit or the two
  // units before it. null otherwise.
  failedPushWeekStart: string | null;
}

// Narrow row shapes the loader hands around in memory. One place so
// both the loader and inScopeAdapter agree on fields.

export interface DailyRevenueLite {
  service_date: string;
  service_id: string;
  is_flat_fee: boolean;
  is_non_revenue: boolean;
  actual_count: number | null;
  actual_price_at_date: number | null;
  price_at_date: number | null;
  projected_count: number | null;
  has_actuals: boolean;
  has_projection: boolean;
  actual_revenue: number | null;
}

export interface ServiceLite {
  service_id: string;
  service_name: string;
  unit: "meals" | "each" | "pans" | "days" | "dollars";
  is_flat_fee: boolean;
  is_non_revenue: boolean;
  active: boolean;
  active_until: string | null;
}

export interface DayMetadataLite {
  service_date: string;
  review_status: string | null;
  event_label: string | null;
  game_type: string | null;
  game_time: string | null;
  week_label: string | null;
}

export interface FinalizeLite {
  id: string;
  week_start: string;
  status: string;
  finalized_at: string;
  push_attempts: number | null;
  push_done_at: string | null;
  push_gave_up_at: string | null;
}

export interface AccountLite {
  team_key: string;
  name: string | null;
  region: string | null;
  level: string | null;
  timezone: string | null;
  active: boolean | null;
}

export interface QboAccountMapLite {
  account_key: string;
  cadence: "weekly" | "biweekly" | null;
  active: boolean | null;
}

export interface PhaseRow {
  phase: string;
  startIso: string;
  endIso: string;
}
