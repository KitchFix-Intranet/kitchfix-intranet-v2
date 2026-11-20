// resolveEffectiveQboMode - the one place the DB's qbo_mode column
// is interpreted.
//
// Before this file: scWeekFinalize.ts read accountMap.qbo_mode
// directly at line 652. After: that line calls this function. Every
// other engine consumer (qboAdapter, qboNotifications, chase*,
// recipients) receives the resolved string as a parameter and
// contains no live/test decision of its own.
//
// Precedence:
//   1. SC_V2_OUTBOUND = "off"   -> "test"  (sender is gated out before
//                                            this value is reached;
//                                            returning "test" keeps the
//                                            type stable if a call sneaks
//                                            through, and names the safe
//                                            direction)
//   2. SC_V2_OUTBOUND = "test"  -> "test"  (force every account onto
//                                            the engine's test path,
//                                            no matter what the DB says)
//   3. SC_V2_OUTBOUND = "live"  -> DB decides: exactly "live" on the
//                                   row is "live"; anything else
//                                   (null, undefined, missing row,
//                                   typo, wrong case, DB read error)
//                                   is "test"
//
// This is the ONLY file in src/lib/sc/** that may contain the
// literal `qbo_mode === "live"`. A grep guard in the test suite
// enforces it. See outbound-gate-call-sites.test.mjs.

import { outboundMode } from "@/lib/sc/outboundGate";

export type QboMode = "test" | "live";

export function resolveEffectiveQboMode(
  accountMap: { qbo_mode: string | null } | null | undefined,
): QboMode {
  const gate = outboundMode();
  if (gate === "off")  return "test";
  if (gate === "test") return "test";
  // gate === "live": the DB speaks.
  return accountMap?.qbo_mode === "live" ? "live" : "test";
}
