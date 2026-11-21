// Pure. The status word the list + drawer show for one row.
//
// Prompt §7 + correction 4:
//   - no V2 send row (v2Send=null): today's words. "sent" ->
//     "With accounting"; "returned" -> whatever the scope's
//     fixWord is ("Needs a fix" / "Sent back").
//   - V2 held: "Sending".
//   - V2 sent + mode='test': "Test send".
//   - V2 sent + mode='live': "With accounting".
//   - V2 gave_up: "Not delivered" with a sub-line "The office
//     has been told."

import type { ListStatus, V2SendStatus } from "./types";

export type StatusTone = "muted" | "block" | "warn" | "info" | "good";

export interface StatusWords {
  label: string;
  tone: StatusTone;
  sub?: string;
}

export function statusWordsFor(
  status: ListStatus,
  v2Send: V2SendStatus | null,
  fixWord: string,
): StatusWords {
  if (status === "returned") {
    return { label: fixWord, tone: "block" };
  }
  // status === "sent" from here. V2 send row - if present -
  // decides the word; v1 invoices read today's.
  if (!v2Send) {
    return { label: "With accounting", tone: "muted" };
  }
  if (v2Send.email_status === "sent") {
    if (v2Send.mode === "test") return { label: "Test send", tone: "info" };
    return { label: "With accounting", tone: "muted" };
  }
  if (v2Send.email_status === "held") {
    return { label: "Sending", tone: "warn" };
  }
  // gave_up
  return { label: "Not delivered", tone: "block", sub: "The office has been told." };
}
