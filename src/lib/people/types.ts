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

export interface WaitingItem {
  id: number;
  module: string; // 'paf' | 'incident' | 'termination' etc., not 'newhire'
  action_type: string | null;
  submitted_at: string; // ISO; drives "N days" waiting
  submitter_worker_id: string | null;
  submitter_name: string | null;
}

// Safe for lists and search. R-PP10: no personal_email, no phone,
// ever. work_email is included because the roster does not show it
// but a client-side search by email is cheap and useful.
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
  waiting: WaitingItem | null; // newest Pending for this person
  waiting_count: number;
}

// Card payload. Adds contact fields subject to R-PP10. See
// src/lib/people/contact.ts for the single enforcement point.
export interface CardPerson extends RosterPerson {
  // Email behaviour: work_email shown for anyone who has one;
  // personal_email ONLY when no work_email AND NOT salaried.
  showPersonalEmail: boolean;
  personal_email_for_display: string | null; // null unless showPersonalEmail
  // Phone behaviour:
  //   - salaried: `phone_for_display` is printed and `phone_href` populates tel:
  //   - hourly:   `phone_for_display` is null (never printed); `phone_href` still populates tel:/sms:
  // `phone_href` is the raw phone; it only ever reaches the DOM
  // inside an href attribute (tel:/sms:).
  phone_for_display: string | null;
  phone_href: string | null;
  // The manager's display_name, resolved against people even when
  // the manager is out of the viewer's scope (per pin 4). No link,
  // no card trigger. Chain is walked with a seen-set guard against
  // the degenerate self-manager / cycle cases.
  manager_name: string | null;
  // "Started Nov 9, 2026 - 1 year with KitchFix" style. Both the
  // long date and the tenure line are computed server-side.
  started_full: string | null;
  tenure_line: string | null;
  anniversary_line: string | null;
  // History rows (R-PP54). Only when `historyVisible` is true for
  // this (viewer, person) pair. The array is already filtered +
  // sorted newest-first.
  historyVisible: boolean;
  history: HistoryRow[];
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
}

export interface TeamView {
  viewer: Viewer;
  sites: SiteNavEntry[]; // more than one site in scope -> left nav; single site -> empty
  people: RosterPerson[]; // already-in-scope, viewer-first pinned
  totals: { people: number; pending: number };
}
