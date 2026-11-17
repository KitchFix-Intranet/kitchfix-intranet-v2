// A day's word, tone and icon.
//
// Pin 7, first match wins:
//   needs_fix     -> review_status = 'flagged'
//   submitted     -> entered or not-served, inside a submitted span
//   closed        -> entered, period closed (and no submitted span over it)
//   entered       -> every projected line answered
//   part_entered  -> entered and a projected line has no actuals row
//   not_served    -> actuals exist, none above 0, something was projected
//   no_actuals    -> projected, locked by a submit or a closed period
//   needs_actuals -> projected, its unit ended before site's today, nothing entered
//   projected     -> projected, nothing entered, unit still open
//   no_service    -> nothing projected, nothing entered
//
// The preview-only states ("Not saved yet", "Saved on this device") are
// not part of this train.

import type { DayStateCode, DayTone, IconName } from "./types";

export interface DayStateInput {
  // Totals across all revenue lines for this day.
  // "meals only" filtering is applied by the caller: only services whose
  // unit = 'meals' contribute to these counters (pin 4).
  //
  // A line's state:
  //   - has_actuals + actual_count > 0  -> counted in hasAnyActualAbove
  //   - has_actuals + actual_count = 0  -> counted in hasAnyActualZero (but not above)
  //   - has_projection + projected_count > 0 -> counted in hasAnyProjectedAbove
  //   - projected > 0 and no actuals row at all -> counted in blankProjectedCount
  hasAnyActualAbove: boolean;      // at least one actuals row above 0
  hasAnyActualZero: boolean;       // at least one actuals row at 0 (whether above exists or not)
  hasAnyProjectedAbove: boolean;   // at least one projected line above 0
  blankProjectedCount: number;     // projected lines with no actuals row
  reviewStatus: string | null;     // sc_day_metadata.review_status
  isInSubmittedSpan: boolean;
  isPeriodClosed: boolean;
  // The day's unit (7 or 14 days) ends on this date <= siteToday - 1.
  // "The unit ended before the site's today."
  unitEndedBeforeSiteToday: boolean;
}

export interface DayStateOut {
  state: DayStateCode;
  word: string;
  tone: DayTone;
  icon: IconName;
}

export function resolveDayState(x: DayStateInput): DayStateOut {
  // 1. Needs a fix.
  if (x.reviewStatus === "flagged") {
    return { state: "needs_fix", word: "Needs a fix", tone: "warn", icon: "flag" };
  }

  // Any entered-shape day: a line above 0, OR a "not served" shape
  // (every projected line answered with 0).
  const marked = !x.hasAnyActualAbove && x.hasAnyActualZero && x.hasAnyProjectedAbove;
  const entered = x.hasAnyActualAbove;

  // 2. Submitted (entered or not-served, inside a submitted span).
  if ((entered || marked) && x.isInSubmittedSpan) {
    if (marked) {
      return { state: "submitted", word: "Submitted", tone: "good", icon: "lock" };
    }
    return { state: "submitted", word: "Submitted", tone: "good", icon: "lock" };
  }

  // 3. Closed (entered, period closed, not covered by a submitted span).
  if ((entered || marked) && x.isPeriodClosed) {
    return { state: "closed", word: "Closed", tone: "muted", icon: "lock" };
  }

  // 4. Entered / 5. Part entered.
  if (entered) {
    if (x.blankProjectedCount > 0) {
      return { state: "part_entered", word: "Part entered", tone: "navy", icon: "pencil" };
    }
    return { state: "entered", word: "Entered", tone: "navy", icon: "check" };
  }

  // 6. Not served (every projected line answered with 0, outside a submit).
  if (marked) {
    return { state: "not_served", word: "Not served", tone: "navy", icon: "ban" };
  }

  // 7./8./9. Projected shapes.
  if (x.hasAnyProjectedAbove) {
    if (x.isPeriodClosed || x.isInSubmittedSpan) {
      return { state: "no_actuals", word: "No actuals", tone: "muted", icon: "minus" };
    }
    if (x.unitEndedBeforeSiteToday) {
      return { state: "needs_actuals", word: "Needs actuals", tone: "warn", icon: "clock" };
    }
    return { state: "projected", word: "Projected", tone: "muted", icon: "circle-dashed" };
  }

  // 10. No service.
  return { state: "no_service", word: "No service", tone: "muted", icon: "minus" };
}
