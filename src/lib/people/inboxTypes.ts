// T3 Inbox types. The row payload sent to the client is deliberately
// narrow: enough to render the row (title, subline, amount, status
// word, sent/decided dates, group, unread flag, why text) and
// absolutely no payload fields. The payload is parsed on the server
// in the drawer loader and never leaves it except as pre-rendered
// detail pairs.

import type { RequestRoute } from "./labels";

export type InboxKind = "paf" | "hire" | "incident";
export type InboxGroup = "needs" | "news" | "pending" | "earlier";

export interface InboxRow {
  id: string;                 // submissions.id (uuid)
  kind: InboxKind;
  title: string;              // "<person name>" or "<club> · <dates>" for travel-self
  subline: string;            // "PAF · Travel reimbursement · 3 days away · St Louis Cardinals · by Joe"
  amount_display: string;     // "$123.45" (formatted) or ""
  status_display: string;     // R-PP7 word mapping ("Approved", "Rejected", "Withdrawn", "Pending")
  status_code: "Pending" | "Complete" | "Rejected" | "Withdrawn" | "Cancelled";
  sent_short: string;         // "Nov 9"
  sent_long: string;          // "Nov 9, 2026"
  decided_short: string | null; // when admin_action_at is set
  decided_long: string | null;
  unread: boolean;            // not yet in people_record_opens for this viewer
  group: InboxGroup;
  // "Needs you" row carries one short reason - "14 days with finance"
  // or "Rejected · see why". Empty string on other groups.
  why_text: string;
  route: RequestRoute;        // for display ("Sent to finance" in the drawer ledger)
  sender_name: string;        // used for "About my team" subline tail
  action_label: string;       // labelForAction output
}

export interface InboxBand {
  // Band title words.
  title: string;              // "N needs you" / "N need you" / "All caught up" / "Nothing here yet"
  phone_line: string;         // "6 need you · 10 pending" or "Nothing sent yet"
  pending_count: number;
  news_count: number;
  needs_count: number;
}

export interface InboxView {
  // Does this viewer have the Sent-by-me / About-my-team switch?
  hasTeamSwitch: boolean;
  // Rows the viewer sent themselves.
  mine: InboxRow[];
  // Rows about someone in the viewer's team (SL + RD only).
  team: InboxRow[];
  // Band + phone head numbers (driven by `mine`).
  band: InboxBand;
}
