// Invoices V2 - train 1 types. Server-authoritative shapes.
// No address lives in these; the loader owns its reads.

// The three statuses the list cares about. "sent" = with accounting.
// "returned" = needs a fix (site / RD) or sent back (office).
// "corrected" / "deleted" / "archived" are filtered out.
export type ListStatus = "sent" | "returned";

// Row type ("credit" shows the word "Credit" + totals already-negative;
// everything else is an "invoice" on the list).
export type InvoiceKind = "credit" | "invoice";

// The three toolbar filters.
export type FilterKey = "all" | "fix" | "acct";

// What the viewer is in the eyes of this lane. Order mirrors §4.
// "office" is the invoice-reviewer flag (is_invoice_admin). "owner"
// is the signed-in owner not previewing (train-1 convenience).
export type ViewerKind =
  | "owner"
  | "office"
  | "regional_director"
  | "site_manager"
  | "none";

// Viewer scope: the set of account_keys the loader is allowed to read
// and the words the surface uses. The "words.fix" prop flips between
// "Needs a fix" (site / RD) and "Sent back" (office).
export interface InvoiceScope {
  kind: ViewerKind;
  accountKeys: string[];     // sites this viewer can see, always
  words: {
    fix: string;              // "Needs a fix" | "Sent back"
    fixPlural: (n: number) => string; // headline "N invoices need a fix" / "N invoices sent back"
  };
}

// The nine (today) / eleven (in scope) site rows for the site select.
export interface SiteNavItem {
  accountKey: string;
  slug: string;
  name: string;
  region: string | null;
}

// Internal server-side row shape. Carries `submitterEmail` and
// `rejection.rejectedBy` because the loader needs both to look up
// first names in `people`. This shape NEVER reaches a client
// component - the loader hands only the sanitised `ListRowView`
// and `DetailRowView` across the server/client boundary.
export interface ListRow {
  id: string;
  accountKey: string;
  kind: InvoiceKind;
  invoiceNumber: string;
  invoiceDate: string | null;   // ISO date
  submittedAt: string;          // timestamp
  submitterEmail: string | null;
  submitterFirstName: string | null;
  totalAmount: number;          // credits stored negative
  vendorName: string;
  vendorId: string | null;
  pageUrl: string | null;       // drive_urls[0] or null
  pageCount: number | null;
  status: ListStatus;
  // Newest rejection for returned rows. Absent otherwise.
  rejection: {
    rejectedAt: string;
    rejectedBy: string | null;
    rejectedByFirstName: string | null;
    reason: string | null;
    note: string | null;
  } | null;
}

// The client-safe shape for a list row. Emails stripped - no field
// on this type ever carries an "@" string. Every client component
// (Drawer, Toolbar, etc.) that touches a row MUST use this type.
export interface ListRowView {
  id: string;
  accountKey: string;
  kind: InvoiceKind;
  invoiceNumber: string;
  invoiceDate: string | null;
  submittedAt: string;
  submitterFirstName: string | null;
  totalAmount: number;
  vendorName: string;
  vendorId: string | null;
  pageUrl: string | null;
  pageCount: number | null;
  status: ListStatus;
  rejection: {
    rejectedAt: string;
    rejectedByFirstName: string | null; // "the office" fallback applied at the component
    reason: string | null;
    note: string | null;
  } | null;
}

// A GL line as stored. gl_breakdown is always an array of this shape
// today (50/50 live samples).
export interface GlLine {
  code: string;
  name: string;
  amount: number;
}

// The one-invoice detail payload used by the drawer (server-only).
export interface DetailRow extends ListRow {
  gl: GlLine[];
  // Count of ai_line_items for this invoice. Only read in the drawer
  // path so the list is quiet.
  lineCount: number;
  // vendors.extract_line_items for this invoice's vendor; null when
  // we can't resolve.
  extractLineItems: boolean | null;
}

// Client-safe detail. Same stripping discipline as ListRowView:
// no `submitterEmail`, no `rejection.rejectedBy`. The drawer
// consumes only this type.
export interface DetailRowView extends ListRowView {
  gl: GlLine[];
  lineCount: number;
  extractLineItems: boolean | null;
}

// Chip counts for the toolbar. Three total per page load.
export interface ChipCounts {
  all: number;
  fix: number;
  acct: number;
}

// "N to fix" per site, derived in app from the already-loaded four
// returned rows. No extra query.
export interface SiteFixCounts {
  byAccountKey: Record<string, number>;
}

// ─── Train 2: Capture ────────────────────────────────────────────

// invoice_drafts.status. Train 2 only writes 'draft' and 'discarded';
// 'sent' is train 3's. The DB check ties status='sent' to submission_id.
export type DraftStatus = "draft" | "sent" | "discarded";

// invoice_drafts.screen - the no-names signal.
export type DraftScreen = "desk" | "phone";

// How a draft reaches the client. owner_email and uploaded_by never
// leave the server; the client gets `is_mine` only.
export interface DraftRow {
  id: string;
  account_key: string;
  owner_email: string;             // server only
  vendor_id: string | null;
  type: InvoiceKind;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  gl_breakdown: GlLineDraft[];
  answers: DraftAnswers;
  screen: DraftScreen | null;
  status: DraftStatus;
  submission_id: string | null;
  created_at: string;
  updated_at: string;
  discarded_at: string | null;
}

// Client-safe view of a draft. No owner_email.
export interface DraftView {
  id: string;
  account_key: string;
  vendor_id: string | null;
  type: InvoiceKind;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  gl_breakdown: GlLineDraft[];
  answers: DraftAnswers;
  screen: DraftScreen | null;
  status: DraftStatus;
  submission_id: string | null;
  created_at: string;
  updated_at: string;              // the If-Match concurrency key
  discarded_at: string | null;
}

// GL line on a draft. Train 2 stores amount as entered (positive);
// train 3 owns the credit sign.
export interface GlLineDraft {
  code: string;
  name: string;
  amount: number;
}

// Answers to one-time questions the server keeps on the draft.
// Shape is open; these keys are the only ones this train reads/writes.
export interface DraftAnswers {
  // STOP question: "This date is N days back. Is that right?"
  date_confirmed_at_more_than_60_days?: true;
  // Copy-check answers (user chose one):
  is_different_invoice?: true;
  is_credit_for?: string;          // submission_id of the originating invoice
}

// invoice_files row + client view.
export interface FileRow {
  id: string;
  draft_id: string | null;
  submission_id: string | null;
  kind: "original" | "outbound";
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  page_count: number | null;
  sort_order: number;
  rotation: 0 | 90 | 180 | 270;
  uploaded_by: string;             // server only
  created_at: string;
  removed_at: string | null;
}

export interface FileView {
  id: string;
  draft_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  sort_order: number;
  rotation: 0 | 90 | 180 | 270;
  created_at: string;
  removed_at: string | null;
  // sha256 is deliberately absent from the client view - internal.
}

// A short, client-safe snapshot of the row the copy check matched.
// Used by the C9 stop block. Never carries email, total, or
// uploader - only what is shown on the stop.
export interface CopyMatchView {
  kind: "same_invoice" | "same_draft";
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  // present only when kind='same_invoice', so the "It is the credit
  // for that invoice" path can stage `is_credit_for = submission_id`.
  submission_id: string | null;
}

// Pure Ready check result - what runReadyCheck returns. The route
// decorates this with copy_match + next_draft_id before replying.
export interface ReadyResult {
  ready: boolean;
  errors: ReadonlyArray<CheckError>;
}

// Server-side check result for the "Check and send" path. Train 2
// does not send; Ready is the only outcome the client needs.
export interface CheckResult extends ReadyResult {
  // The matched row when a copy-error is present. null otherwise.
  copy_match: CopyMatchView | null;
  // Oldest draft that is not ready for this (owner, site), excluding
  // the one just checked. The sitting cursors to it after a ready
  // pass. null means "you are set" - the landing will render E.
  next_draft_id: string | null;
}

// Draft + a server-computed ready flag and the missing-fields list.
// The landing (B1 headline, B6 rows) reads this instead of
// re-implementing the check client-side.
export interface DraftListView extends DraftView {
  vendor_name: string | null;
  ready: boolean;
  // Short list of what is missing, in plain words. Empty when ready.
  // Capped to 4 items for display.
  missing: string[];
}

export interface CheckError {
  // field hint for focus-on-error. 'files' = no file attached; 'coding'
  // = adds-up mismatch or unknown code; 'copy' = copy check failed.
  field:
    | "vendor_id"
    | "type"
    | "invoice_number"
    | "invoice_date"
    | "total_amount"
    | "gl_breakdown"
    | "files"
    | "copy"
    | "date_more_than_60";
  message: string;
}

