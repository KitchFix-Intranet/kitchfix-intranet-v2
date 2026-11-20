// Train 6: one place that reads `SC_V2_OUTBOUND` for the reminder
// lane. The recipients-level mode decision (`resolveEffectiveQboMode`
// in the engine) reads the per-account qbo_mode column, and the
// repo's grep-guard allows exactly one file to hold that literal.
// Reminders cannot use that helper - three calendar sites have no
// row in `sc_qbo_account_map` - so they consult the switch directly
// and never touch the per-account column. The guard test in
// `outbound-gate-call-sites.test.mjs` continues to pass.
//
// Semantics mirror the engine's rule:
//   off   -> no wire, no insert, no record of a send.
//   test  -> owner only, subject prefixed with "[TEST] ",
//            is_test=true on sc_v2_reminder_sent.
//   live  -> the real recipient list, is_test=false.
//
// Pure function so the dry-run can report it per site without
// routing through the real sender.

import { outboundMode, type OutboundMode } from "@/lib/sc/outboundGate";

export type ReminderMode = "off" | "test" | "live";

export function reminderMode(mode: OutboundMode = outboundMode()): ReminderMode {
  if (mode === "off") return "off";
  if (mode === "test") return "test";
  return "live";
}
