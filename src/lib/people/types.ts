// People Portal T2 types. Server-authoritative. The `Viewer` is
// resolved once per request from the signed-in email (honouring an
// owner `?as=<worker_id>` override). The two payload shapes -
// `RosterPerson` for lists/search and `CardPerson` for the drawer -
// enforce the R-PP10 contact rule: personal_email and phone never
// appear on `RosterPerson`.

export type ViewerRole =
  | "corporate"
  | "regional_director"
  | "site_leader"
  | "site_manager";

// The `people` columns the scope resolver and contact rule read.
// A projection of the real row, not the whole DB row.
//
// PII posture (R-PP10 reinforcement, 2026-11-11):
// `personal_email`, `phone`, `start_date` and `birthday` are OPTIONAL
// here because the viewer and roster SELECTs never pull them. Only
// the card SELECT in loadPerson.ts pulls those columns, after which
// toCardPerson() in contact.ts applies the R-PP10 gate. If a row
// reaches the scope resolver or roster mapper with those fields
// missing, that is correct - a defect would be their accidental
// presence, not their absence.
export interface PeopleRow {
  worker_id: string;
  display_name: string | null;
  title: string | null;
  account_key: string;
  region: string | null;
  work_email: string | null;
  manager_worker_id: string | null;
  is_corp: boolean;
  is_salaried: boolean;
  is_site_leader: boolean;
  is_regional_director: boolean;
  pp_full_access: boolean;
  pp_review: boolean;
  status: string | null;
  // Narrow-SELECT paths leave these undefined; only the card SELECT
  // populates them. See src/lib/people/loadPerson.ts.
  personal_email?: string | null;
  phone?: string | null;
  start_date?: string | null;
  birthday?: string | null;
}

export interface AccountRow {
  team_key: string;
  name: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  active: boolean | null;
  level: string | null;
}

export interface Viewer {
  worker_id: string;
  display_name: string;
  work_email: string;
  account_key: string;
  region: string | null;
  role: ViewerRole | null; // null = viewer does not fit the four kinds
  is_corp: boolean;
  is_regional_director: boolean;
  is_site_leader: boolean;
  is_salaried: boolean;
  pp_full_access: boolean;
  pp_review: boolean;
  // Owner-preview only. When the signed-in owner viewed as another
  // person, the banner reads "Viewing as <name>. Owner preview."
  // `previewOf` is non-null only in that state and is never used to
  // grant anything; it carries the viewer's real identity for the
  // ribbon.
  previewOf: { worker_id: string; display_name: string } | null;
}

// Full waiting shape, used ONLY on the viewer's own row on the
// "You" card (SelfRosterPerson). Never on any other row. Request
// fields (id, module, action_type, submitted_at, submitter_*) do
// not appear in the roster payload for anyone else - see
// RosterPerson below, which carries `waiting_count` and nothing
// else about the request.
export interface WaitingItem {
  id: number;
  module: string; // 'paf' | 'incident' | 'termination' etc., not 'newhire'
  action_type: string | null;
  submitted_at: string; // ISO; drives "N days" waiting
  submitter_worker_id: string | null;
  submitter_name: string | null;
  label: string;
}

// Safe for lists and search. R-PP10: no personal_email, no phone,
// ever. work_email is included because the roster does not show it
// but a client-side search by email is cheap and useful.
//
// T2.2.2 (2026-11-13). NO request fields on this type. A non-self
// roster row carries a `waiting_count` only - the Pending pill
// renders when the count is > 0. Module, action_type, submitted_at,
// submitter_* all stay server-side. The pending `label`
// ("PAF: Transfer") was removed in T2.2.1 and the remaining
// request fields are removed here because the label is trivially
// rebuilt from module + action_type.
export interface RosterPerson {
  worker_id: string;
  display_name: string;
  title: string | null;
  account_key: string;
  account_region: string | null; // joined from accounts
  work_email: string | null;
  is_corp: boolean;
  is_salaried: boolean;
  is_site_leader: boolean;
  is_regional_director: boolean;
  initials: string;
  waiting_count: number;
}

// The viewer's own row. The ONE place in the roster payload where
// a WaitingItem is allowed to appear: on the "You" card, where the
// render shows "<label> · Pending" for the viewer's own request.
export interface SelfRosterPerson extends RosterPerson {
  waiting: WaitingItem | null;
}

// Card payload. Adds contact fields subject to R-PP10. See
// src/lib/people/contact.ts for the single enforcement point.
export interface CardPerson extends RosterPerson {
  // Email behaviour: work_email shown for anyone who has one;
  // personal_email ONLY when no work_email AND NOT salaried.
  showPersonalEmail: boolean;
  personal_email_for_display: string | null; // null unless showPersonalEmail
  // T2.2 (2026-11-12). The card's email KV label changes per which
  // address is rendered: "Work email" when work_email is present,
  // "Personal email" when personal_email_for_display is used.
  email_label: "Work email" | "Personal email" | null;
  email_for_display: string | null; // selected by R-PP10 gate
  // Phone behaviour:
  //   - salaried: `phone_for_display` is printed and `phone_href` populates tel:
  //   - hourly:   `phone_for_display` is null (never printed); `phone_href` still populates tel:/sms:
  phone_for_display: string | null;
  phone_href: string | null;
  // T2.2 card chrome from the render.
  eyebrow: string;              // club name (accounts.name) or team_key
  title_suffix: string;         // " (you)" when the viewer is on their own card
  role_display: string;         // "Executive Chef · site leader" etc.
  site_display: string;         // "St Louis Cardinals · Jupiter, FL"
  started_line: string | null;  // "May 18, 2026 · 5 months · 1 year on May 18"
  // Reports to (pin 4, name only, no link).
  manager_name: string | null;
  // Retained from T2 for the one-line stored strings (unused in T2.2
  // card rendering but still populated for compatibility).
  started_full: string | null;
  tenure_line: string | null;
  anniversary_line: string | null;
  // History rows (R-PP54). Only when `historyVisible` is true for
  // this (viewer, person) pair.
  historyVisible: boolean;
  history: HistoryRow[];
  // T2.2 "In flight" (pending items). Same visibility rule as
  // history: a viewer who may not open a request sees a short
  // state-only note per pending item, not the rows.
  // `inFlightRows` populated when visible; `inFlightNotes`
  // populated when hidden. Never both at the same time.
  inFlightVisible: boolean;
  inFlightCount: number;
  inFlightRows: InFlightRow[];
  // T2.2.1 (2026-11-13). State-only sentences per pending item for
  // viewers restricted by R-PP54. One string per request: "<what>
  // sent by <sender>, waiting <age>. Only the sender, their manager
  // chain, HR and finance can open it." No amounts, no notes, no
  // other fields.
  inFlightNotes: string[];
}

export interface InFlightRow {
  id: number;
  kind: "paf" | "incident" | "termination" | "other";
  label: string;        // "PAF: Transfer"
  submitter_name: string | null;
  sent_short: string;   // "Nov 9"
  wait_days: string;    // "18 days" / "today" / "1 day"
  // True when the submission is >= LATE_DAYS old. Same threshold as
  // the band warn tone - see src/lib/people/thresholds.ts.
  late: boolean;
}

export interface HistoryRow {
  id: number;
  action: string; // short label - "PAF submitted" etc.
  date: string; // ISO; shown as "Nov 9" on the card
  dateLong: string; // "Nov 9, 2026" - used in the title attribute
  submitter_name: string;
  // Status word on screen (R-PP7): 'Complete'->"Approved",
  // 'Cancelled'->"Withdrawn", 'Pending'->"Pending" (never surfaced
  // in History - History is final-status only), others as-is.
  status_display: string;
}

export interface SiteNavEntry {
  account_key: string;
  name: string; // display name from accounts.name or team_key
  // T2.1 fix 4 (2026-11-12). Two sites with the same team name
  // (two "St Louis Cardinals", two "Cincinnati Reds") must be
  // distinguishable at a glance. `place` is "<city>, <state>" when
  // accounts has them, else the account_key. `leader_name` is the
  // first active is_site_leader for the account, or null.
  place: string;
  leader_name: string | null;
  region: string | null;
  count: number; // people in scope on this site
  // T2.1 fix 7 (2026-11-12). "requests waiting" = pending ITEMS,
  // not distinct people. Band total, roster head total and site
  // list sum all count items.
  waiting: number;
  // T2.2 (2026-11-12). Match the render's site list + panel head.
  // `mark` is the 3-letter badge (team prefix or "KF" for CORP).
  // `city` is the short place (no state) that renders beside the
  // name in the left nav. `city_state` is the full "City, ST" for
  // the panel head. `level` renders between city_state and count
  // on the panel head; null means omit the slot.
  mark: string;
  city: string;
  city_state: string;
  level: string | null;
}

// T2.2 (2026-11-12). Per-site roster for the right-side panel + the
// collapsible phone stack. People are pre-sorted (site_leader -
// salaried - hourly) with `dividerAt` indicating where the first
// hourly row sits (or null when no hourly follows a salaried).
export interface SitePanel {
  entry: SiteNavEntry;
  people: RosterPerson[]; // excludes the viewer (lives on the "You" card)
  dividerAt: number | null;
}

export interface TeamView {
  viewer: Viewer;
  sites: SiteNavEntry[]; // more than one site in scope -> left nav; single site -> empty
  people: RosterPerson[]; // kept for search-across-all compatibility
  // `pending` is the full in-scope pending items count. `pending_late`
  // is the subset >= LATE_DAYS old; the band warn tone keys off it
  // so the band only warns when something has actually waited too
  // long, not on every fresh request.
  totals: { people: number; pending: number; pending_late: number };
  // T2.2 additions. The page renders a selected panel at a time.
  panels: Record<string, SitePanel>;
  defaultSiteKey: string;
  // The viewer's own row (pinned on the top "You" card). Null when
  // the viewer has no in-scope roster entry for themselves (rare).
  // T2.2.2 (2026-11-13): this is the ONLY roster-shaped field that
  // carries a WaitingItem. Every other RosterPerson in `people` /
  // `panels` has no request fields at all - only `waiting_count`.
  selfRow: SelfRosterPerson | null;
}
