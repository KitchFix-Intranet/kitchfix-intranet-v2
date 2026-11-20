// Pure classifier: given a site's week-view (already resolved against
// resolveWeekState) + extra flags, pick the Sites board row kind.
//
// Keeps the state machine single: resolveWeekState decides the word,
// this function names which of the four groups the row sits in.

import type { WeekStateCode, DayStateCode } from "@/lib/sc/calendar/types";
import type { SiteRowKind } from "./types";

export interface ClassifyInput {
  weekState: WeekStateCode;         // from resolveWeekState
  isBilled: boolean;
  hasPushFailedRowV2: boolean;      // office only; feed false for RD
  isOfficeViewer: boolean;
  anyFlaggedDay: boolean;
  anyUnpricedBillableLine: boolean; // "stuck": billed site has a line with no invoice line
  dayStates: readonly DayStateCode[];
  // The two overrides that let a never-submitted site read as
  // "open" instead of "late" on a unit that has ended. Fed by the
  // isAskedYet() helper at the call site.
  isAskedYet: boolean;
}

export function classifyRow(x: ClassifyInput): SiteRowKind {
  // Office-only: a V2 submit whose push gave up wins over everything.
  if (x.hasPushFailedRowV2 && x.isOfficeViewer) return "push";

  // Submitted (success-ish):
  if (x.weekState === "submitted") {
    return x.isBilled ? "sent" : "noinv";
  }

  // No service this week at all.
  if (x.weekState === "not_serving") return "off";

  // Period closed before a submit ever happened: treat as "sent" if
  // billed (v1 history) else "noinv". We do not surface "over" in
  // this train (no season reader); it is reserved.
  if (x.weekState === "period_closed") {
    return x.isBilled ? "sent" : "noinv";
  }

  // Stuck wins over flag + late within "Needs someone".
  if (x.anyUnpricedBillableLine) return "stuck";
  if (x.anyFlaggedDay) return "flag";

  // Still-open week (unit ended, not submitted). The exempt case
  // falls back to "open" so the row is not counted as late.
  if (x.weekState === "still_open") {
    return x.isAskedYet ? "late" : "open";
  }

  // Open-week "entered": every projected line answered.
  if (x.weekState === "entered") return "entered";

  // Open-week "to_enter": work still to go.
  if (x.weekState === "to_enter") return "open";

  return "open";
}
