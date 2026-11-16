// src/lib/sc/types.ts
//
// Row types and shared types for the Service Calendar engine.
//
// One interface per database table or view the engine reads. Each
// interface holds only the columns the engine reads. Nullability
// follows what the database reports (checked against the live schema
// on 2026-11-16), not what the code treats a value as.
//
// Three columns come with a note about v1 behaviour:
//   - accounts.team_name: the engine selects this name, but the
//     `accounts` table has no `team_name` column - the column is
//     `name`. The query returns an error and the account label is
//     always null. Carried forward from v1; a finding for train 2
//     part two.
//   - sc_qbo_account_map.salaried_manager_emails and qbo_term_id:
//     mentioned in engine comments but never in the live schema and
//     never selected. Not included in AccountMapRow.
//   - sc_daily_revenue.actual_revenue: the view has it, but it is
//     not in REVENUE_COLS and no caller inside the engine selects
//     it. sumBillablePretaxCents is called from outside the engine
//     with its own row shape; see SumBillableRow below.

import type { SupabaseClient } from "@supabase/supabase-js";

// Re-exported so engine files can import the Supabase client type
// from one place without reaching for the dependency directly.
export type { SupabaseClient };

// ─────────────────────────────────────────────────────────────────
// Database row types - columns the engine reads
// ─────────────────────────────────────────────────────────────────

// accounts - scWeekFinalize.ts selects `name` from accounts, matched
// on `team_key`. Nullable because the lookup is soft (fireN1 carries
// sensible fallbacks). Changed 2026-11-16 from `team_name` to `name`
// per Kevin ruling - the `team_name` column does not exist in the
// schema; v1 and train 2 part one both silently fetched null.
export interface AccountRow {
  name: string | null;
}

// contacts - scWeekFinalize.ts reads name for submitter lookup.
export interface ContactRow {
  name: string;
}

// people - three distinct read shapes.
export interface PersonOverrideRow {
  work_email: string;
}

export interface PersonManagerRow {
  // Set only on the batch select in getSalariedManagerEmailsBatch.
  account_key?: string | null;
  // work_email is nullable at schema level; the queries filter
  // WHERE work_email IS NOT NULL, so at the result level it is a
  // string, but the column type is kept nullable here.
  work_email: string | null;
  display_name: string | null;
  // is_site_leader is boolean NOT NULL in the schema.
  is_site_leader: boolean;
}

// sc_daily_actuals - two distinct read shapes.
export interface DailyActualsLatestWriterRow {
  // created_by is nullable at schema level; filtered LIKE "%@%" so
  // non-null at result level. Typed nullable for honesty.
  created_by: string | null;
  // created_at is an ISO timestamp.
  created_at: string;
}

export interface DailyActualsCompletenessRow {
  service_date: string;
  actual_count: number;
}

// sc_daily_projections - scWeekFinalize.ts completeness.
export interface DailyProjectionsRow {
  service_date: string;
  projected_count: number;
}

// sc_daily_revenue - the view. Every column is nullable at the view
// level in the database. The split below carries the engine's
// understanding: columns that come from the service and the day
// (service_id, account_key, etc) are typed present, and the fields
// that may be absent (actual_count, prices, projected_count, period,
// week_label) are typed nullable. Keeping the split so downstream
// consumers do not have to re-narrow every field.
export interface DailyRevenueRow {
  service_date: string;
  service_id: string;
  service_name: string;
  account_key: string;
  is_flat_fee: boolean;
  is_tax_free: boolean;
  is_non_revenue: boolean;
  actual_count: number | null;
  actual_price_at_date: number | null;
  price_at_date: number | null;
  projected_count: number | null;
  // period is text "1".."13" at the view level.
  period: string | null;
  // week_label is text, nullable per F17.
  week_label: string | null;
  has_actuals: boolean;
  has_projection: boolean;
}

// The row shape sumBillablePretaxCents reads. This is NOT a view
// row - the view's REVENUE_COLS does not include actual_revenue.
// The caller lives outside the engine (loadMonthDataPostgres) and
// hands rows in with the four fields the header names. actual_revenue
// is nullable because the view's column is nullable; the function
// already guards it with `Number(r.actual_revenue) || 0`.
export interface SumBillableRow {
  service_id: string;
  is_non_revenue: boolean;
  has_actuals: boolean;
  actual_revenue: number | null;
}

// sc_day_metadata - two read shapes plus the clear update.
export interface DayMetadataReviewRow {
  service_date: string;
  // review_status text, null. Observed values: "approved", "flagged".
  review_status: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface DayMetadataWeekLabelRow {
  // scWeekFinalize narrow select for biweekly pair index.
  week_label: string;
}

// sc_week_finalize. finalized_at is NOT NULL in the schema.
export interface FinalizeRow {
  id: string;
  account_key: string;
  week_start: string;
  // status is plain text; observed values include "finalized" and
  // "push_failed". Typed string, not a union.
  status: string;
  finalized_by: string;
  finalized_at: string;
}

// sc_export_ledger - read and insert shapes.
export interface ExportLedgerRow {
  id: string;
  qbo_invoice_id: string | null;
  qbo_doc_number: string | null;
  pretax_total_cents: number;
  attempt: number;
}

export interface ExportLedgerInsert {
  account_key: string;
  week_start: string;
  week_end: string;
  // cadence_unit is text in the ledger row; "weekly" or "biweekly"
  // in practice. Typed string to match the schema.
  cadence_unit: string;
  invoice_slot: string;
  payload_hash: string;
  qbo_invoice_id: string | null;
  qbo_doc_number: string | null;
  pretax_total_cents: number;
  // status is plain text. Observed values written by the engine:
  // "created", "failed", "test". "superseded" is written elsewhere.
  // Typed string so a value this file does not write does not force
  // a union claim.
  status: string;
  attempt: number;
  error: string | null;
  is_test: boolean;
  created_by: string;
}

// sc_qbo_account_map. The columns this type carries are the columns
// the engine reads. salaried_manager_emails and qbo_term_id do not
// exist in the schema and are not included.
export interface AccountMapRow {
  account_key: string;
  qbo_customer_id: string;
  qbo_customer_name: string;
  qbo_taxcode_id: string;
  qbo_class_id: string;
  // qbo_mode and cadence are plain text in the schema. The engine
  // treats anything other than "live" as test, so typing a union
  // would claim a guarantee the database does not give.
  qbo_mode: string;
  cadence: string;
  active: boolean;
  notify_operators: boolean;
  biweekly_anchor: string | null;
  rdo_email: string | null;
  qbo_bill_email_cc: string | null;
  bg_report_recipients: string[] | null;
}

// sc_qbo_service_map. qbo_item_id and qbo_line_description are
// nullable in the schema. line_desc_style is text, null.
export interface ServiceMapRow {
  account_key: string;
  service_id: string;
  invoice_slot: string;
  qbo_item_id: string | null;
  qbo_line_description: string | null;
  aggregate_group: string | null;
  line_desc_style: string | null;
  tax_override: string | null;
  export_excluded: boolean;
  active: boolean;
}

// sc_invoice_slot_codes.
export interface SlotCodeRow {
  invoice_slot: string;
  slot_code: string;
}

// ─────────────────────────────────────────────────────────────────
// Database function return types
// ─────────────────────────────────────────────────────────────────

// sc_is_day_locked(p_account_key text, p_service_date date) -> boolean.
// nextval_sc_invoice_test_number() -> bigint, arrives as a number.

// ─────────────────────────────────────────────────────────────────
// Shared engine types used across more than one file
// ─────────────────────────────────────────────────────────────────

// The invoice-line shape carried from buildInvoicePayload through
// postInvoiceDraft and on to N1 / recordCopyPdf.
export interface LineItem {
  serviceName: string;
  serviceDate: string;
  qty: number;
  rateCents: number;
  amountCents: number;
}

// A record for one QBO invoice slot after postInvoiceDraft. Carried
// into fireN1, fireNoOpAlert, buildRecordCopyPdf. qboInvoiceId and
// qboDocNumber are optional because the ledger adoption path in
// qboAdapter can return them as undefined; downstream consumers
// handle that with optional chaining.
export interface InvoiceRecord {
  invoiceSlot: string;
  qboInvoiceId?: string;
  qboDocNumber?: string;
  pretaxTotalCents: number;
  lineCount: number;
  isTest: boolean;
  qboLink: string;
  ledgerRowId: string;
  lineItems?: LineItem[];
}

// A row describing one reviewer's approval. Two shapes are
// legitimate inputs:
//   - snake_case: the sc_day_metadata select at scWeekFinalize line
//     1076 (`reviewed_by, reviewed_at, service_date`). On the real
//     finalize path, `reviewed_by` carries a display name (confirmed
//     on 303 rows against the live database on 2026-11-16).
//   - camelCase: existing fireN1 tests and some early callers.
// computeApproverPhrase reads either form per Kevin ruling
// 2026-11-16, so both are accepted here.
export interface ReviewRow {
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  service_date?: string | null;
  reviewedBy?: string;
  reviewedAt?: string;
  serviceDate?: string;
}

// Recipients split used by resolveRecipients and every notification
// caller.
export interface Recipients {
  to: string[];
  cc: string[];
}

// The strings for which notification each fire function is called
// with. The hand-written union is checked against the keys of
// NOTIFICATION_TYPES at recipients.ts.
export type NotificationType = "N1" | "N2" | "N3.reminder" | "N3.urgent" | "N4";

// The shape networkFetch wrappers return from the QBO proxy.
export interface NetworkResponse {
  ok: boolean;
  status: number;
  body: string;
}

// The shape emailSender resolves to. sendEmailSA (the seam) returns
// "sent" | "failed"; the notification wrappers additionally return
// skipped reasons (missing_env, etc).
export type EmailResult =
  | "sent"
  | "failed"
  | "not_sent"
  | string; // skipped reasons carry a prose tag; keep string union open

// The shape sendSlack resolves to. The engine sets `sent` on every
// return path (true for success, false otherwise), so `sent` is
// non-optional here.
export interface SlackResult {
  sent: boolean;
  error?: string;
  skipped?: string;
}

// ─────────────────────────────────────────────────────────────────
// QuickBooks invoice payload shapes (engine builds; adapter posts)
// ─────────────────────────────────────────────────────────────────
//
// The line shape QBO accepts for an invoice line. DetailType is
// always "SalesItemLineDetail" for the engine - buildInvoicePayload
// emits no other DetailType. LineNum is injected by sortLines after
// each invoice's Line[] is sorted. Fields the engine never reads
// but QBO might carry are left unknown.
export interface QboInvoiceLine {
  DetailType: "SalesItemLineDetail";
  Amount: number;
  Description?: string;
  SalesItemLineDetail: {
    ServiceDate?: string;
    ItemRef: { value: string; name?: string };
    ClassRef?: { value: string };
    UnitPrice?: number;
    Qty: number;
    TaxCodeRef: { value: string };
  };
  LineNum?: number;
}

// The invoice shape buildInvoicePayload emits and qboAdapter posts.
// `_slot` and `_preTaxSubtotal` are internal markers stripped before
// the POST by stripInternalMarkers. DocNumber + BillEmail + Cc + Bcc
// are injected by qboAdapter after the strip. PrivateNote is set by
// markPayloadAsTest on test-mode drafts only.
export interface QboInvoice {
  _slot: string;
  _preTaxSubtotal: number;
  CustomerRef: { value: string; name: string };
  TxnDate: string;
  SalesTermRef: { value: string };
  TxnTaxDetail: { TxnTaxCodeRef: { value: string } };
  CustomerMemo: { value: string };
  Line: QboInvoiceLine[];
  DocNumber?: string;
  BillEmail?: { Address: string };
  BillEmailCc?: { Address: string };
  BillEmailBcc?: { Address: string };
  PrivateNote?: string;
}

// The shape buildInvoicePayload returns.
export interface BuildInvoicePayloadResult {
  invoices: QboInvoice[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────
// Notification fire-function result shapes
// ─────────────────────────────────────────────────────────────────

// Recipients split returned by resolveRecipients plus the optional
// resolved-before-override fields that fireN3 stamps onto its
// recipients block so the Slack message can name who would have
// been on the live-mode line.
export interface RecipientsOut {
  to: string[];
  cc: string[];
  resolvedTo?: string[];
  resolvedCc?: string[];
}

// The email result object every fire* function returns. `result`
// is the sendEmailSA outcome ("sent" | "failed") or a skip reason
// string ("not_sent", "missing_env:GOOGLE_PRIVATE_KEY", etc). The
// skip-only `missing` field appears when checkMailerEnv flags an
// unconfigured env var.
export interface FireEmailResult {
  result: string;
  missing?: string;
}

// The slack result block. `text` is what would be (or was) posted;
// `result` is the sendSlack outcome.
export interface FireSlackResult {
  text: string;
  result: SlackResult;
}

// The PDF summary block fireN1 attaches when the record-copy PDF
// built successfully and its pretax matched the invoice records.
export interface FirePdfSummary {
  filename: string;
  pretaxCents: number;
  lineCount: number;
  byteLength: number;
}

// fireN1 return. pdf is nullable when the PDF failed to build or
// when the caller opted out; pdfError carries the failure reason.
export interface FireN1Result {
  recipients: RecipientsOut;
  subject: string;
  preheader: string;
  html: string;
  email: FireEmailResult;
  slack: FireSlackResult;
  pdf: FirePdfSummary | null;
  pdfError?: string | null;
  approvers: string[];
}

// fireN2 return (push-failed notification).
export interface FireN2Result {
  recipients: RecipientsOut;
  subject: string;
  preheader: string;
  html: string;
  slack: FireSlackResult;
  email: FireEmailResult;
}

// fireNoOpAlert return (operator-resubmitted-noop notification).
// Same shape as fireN2 since both are Kevin-focused alerts.
export type FireNoOpAlertResult = FireN2Result;

// fireN3 return (chase ladder).
export interface FireN3Result {
  recipients: RecipientsOut;
  subject: string;
  preheader: string;
  html: string;
  email: FireEmailResult;
  slack: FireSlackResult;
  noSiteRecipient: boolean;
}

// Legacy dry-run entry points. renderN1 returns a flat render, no
// slack block. renderN2 returns both email and slack as dry-run
// shapes. Kept as the exact shape PR-C's tests assert.
export interface RenderN1Result {
  mode: "dryrun";
  to: string[];
  subject: string;
  html: string;
}

export interface RenderN2Result {
  email: { mode: "dryrun"; to: string[]; subject: string; html: string };
  slack: { mode: "dryrun"; text: string };
}
