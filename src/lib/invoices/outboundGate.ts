// INVOICES_V2_OUTBOUND - the Invoices V2 outbound gate.
//
// This gate sits between every V2 send path and the outside
// world. The same shape as src/lib/sc/outboundGate.ts: env-only,
// three states, default off for anything unknown.
//
//   off   - the send route refuses with 409 sending_off and the
//           retry route does nothing and says so in its JSON.
//           Check-and-send answers "Ready" today. Shipping
//           configuration (env UNSET in production).
//
//   test  - every send goes out, but recipients always come from
//           the row's own mode (correction 3). Fresh sends write
//           mode='test', which can never resolve to the AP
//           address. A row already stored as mode='test' stays
//           test forever.
//
//   live  - every send goes out; new sends write mode='live';
//           recipients come from each row's own mode, so a row
//           saved earlier as mode='test' still goes to the test
//           address, never AP. Kevin's deliberate flip.

export type OutboundMode = "off" | "test" | "live";

export function outboundMode(): OutboundMode {
  const raw = process.env.INVOICES_V2_OUTBOUND;
  if (raw === "test") return "test";
  if (raw === "live") return "live";
  return "off";
}
