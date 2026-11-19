// Billed-outbound gate (round 2 billing safety).
//
// A thin predicate used by the submit route. Called right after the
// scope check, before submitWeek runs. With SC_V2_OUTBOUND = off:
//   - Billed site: refuse. v1 shares sc_week_finalize; a V2 submit
//     would lock the row and no push would ever fire.
//   - Non-billed site: allow. There is no push to miss, so the
//     office can rehearse the finish at any time.
// With SC_V2_OUTBOUND = test or live, the predicate always allows;
// the per-account qbo_mode decides sandbox vs real at the single
// door out (resolveEffectiveQboMode, called inside the engine).
//
// Pure function so the test harness does not need to stand up a
// route. One env read, no DB touch.

import { outboundMode, type OutboundMode } from "@/lib/sc/outboundGate";

export type SubmitAllowed =
  | { allowed: true }
  | { allowed: false; code: "OUTBOUND_OFF"; message: string };

export function isSubmitAllowed(
  isBilled: boolean,
  mode: OutboundMode = outboundMode(),
): SubmitAllowed {
  if (mode === "off" && isBilled) {
    return {
      allowed: false,
      code: "OUTBOUND_OFF",
      message: "Submitting to accounting is not switched on yet.",
    };
  }
  return { allowed: true };
}
