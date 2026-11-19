// SC_V2_OUTBOUND - V2-wide outbound gate.
//
// All four billed accounts in sc_qbo_account_map are already
// qbo_mode='live' (v1 bills them live). The per-account column is
// NOT a safety valve for V2 - it's the production billing switch.
// This gate sits between every V2 code path and the outside world.
//
// Three states, env-only, read via process.env.SC_V2_OUTBOUND:
//
//   off   - the outbound seam stays inert. Email returns "failed",
//           network throws. Byte-identical to train 1 behaviour.
//           Shipping configuration (env var UNSET in production).
//
//   test  - every send goes out, but every account is forced onto
//           the engine's existing test routing: Kevin-only
//           recipients, [TEST] Slack prefix, QuickBooks test
//           customer in the production realm. Kevin's rehearsal
//           mode - no real client is touched.
//
//   live  - every send goes out; per-account qbo_mode from the DB
//           decides test vs live routing. Four live accounts bill
//           for real. Kevin's deliberate flip after the relay key
//           is changed.
//
// The default is `off` for every unknown value: missing env var,
// empty string, typo, wrong case, anything. Only the exact strings
// "test" and "live" leave the default.

export type OutboundMode = "off" | "test" | "live";

export function outboundMode(): OutboundMode {
  const raw = process.env.SC_V2_OUTBOUND;
  if (raw === "test") return "test";
  if (raw === "live") return "live";
  return "off";
}
