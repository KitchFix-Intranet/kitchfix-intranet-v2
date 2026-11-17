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
