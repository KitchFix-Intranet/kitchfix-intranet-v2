// A week's word, tone and icon.
//
// Pin 8, with the push-failed override from pin 8 (corp viewer only):
//   submitted     -> there is a live sc_week_finalize row over this week
//   push_failed   -> that row has push_gave_up_at set OR status='push_failed',
//                    AND the viewer is corporate; everyone else reads submitted
//   not_serving   -> no entered day and no projected day with service
//   period_closed -> every day is inside a closed period and the week is not submitted
//   still_open    -> the week ended with no submit over it; has service
//   to_enter      -> open week, work still to do
//   entered       -> open week, every projected line answered

import type { WeekStateCode, DayTone, IconName, DayView } from "./types";

export interface WeekStateInput {
  days: DayView[];                 // 7 or 14 (biweekly unit)
  isSubmitted: boolean;
  isPushFailed: boolean;           // row has push_gave_up_at OR status='push_failed'
  isCorpViewer: boolean;
  isPeriodClosedForEveryDay: boolean;
  unitEndedBeforeSiteToday: boolean;
}

export interface WeekStateOut {
  state: WeekStateCode;
  word: string;
  tone: DayTone;
  icon: IconName;
}

export function resolveWeekState(x: WeekStateInput): WeekStateOut {
  const hasEntered = x.days.some((d) => d.state === "entered" || d.state === "part_entered" || d.state === "submitted" || d.state === "closed" || d.state === "not_served");
  const hasService = hasEntered || x.days.some((d) => d.state === "projected" || d.state === "needs_actuals" || d.state === "no_actuals");

  if (x.isSubmitted) {
    if (x.isPushFailed && x.isCorpViewer) {
      return { state: "push_failed", word: "QuickBooks push failed", tone: "block", icon: "triangle-alert" };
    }
    return { state: "submitted", word: "Submitted", tone: "good", icon: "lock" };
  }

  if (!hasService) {
    return { state: "not_serving", word: "No service", tone: "muted", icon: "minus" };
  }

  if (x.isPeriodClosedForEveryDay) {
    return { state: "period_closed", word: "Period closed", tone: "muted", icon: "lock" };
  }

  if (x.unitEndedBeforeSiteToday) {
    return { state: "still_open", word: "Still open", tone: "warn", icon: "clock" };
  }

  // Open week.
  const toEnter = x.days.filter((d) => d.state === "projected" || d.state === "needs_actuals" || d.state === "part_entered").length;
  if (toEnter > 0) {
    return {
      state: "to_enter",
      word: `${toEnter} day${toEnter === 1 ? "" : "s"} to enter`,
      tone: "muted",
      icon: "circle-dashed",
    };
  }
  return { state: "entered", word: "Entered", tone: "navy", icon: "check" };
}
