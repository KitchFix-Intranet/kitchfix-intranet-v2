// Invoices V2 - the row-mode x switch-mode delivery gate.
//
// Correction 3: a test row is deliverable when the switch is
// test or live. A live row is deliverable only when the switch
// is live. Switch off: nothing goes out. Recipients always come
// from the row's own mode (see recipients.ts).
//
// This is called TWICE per attempt: once in the send route
// before claiming + delivering, and once in the retry route per
// claimed row. Pure.

import type { RowMode } from "./recipients";
import type { OutboundMode } from "./outboundGate";

export function mayDeliver(rowMode: RowMode, switchMode: OutboundMode): boolean {
  if (switchMode === "off") return false;
  if (rowMode === "live") return switchMode === "live";
  // rowMode === "test"
  return switchMode === "test" || switchMode === "live";
}
