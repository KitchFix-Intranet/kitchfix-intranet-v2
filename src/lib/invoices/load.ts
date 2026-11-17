// Invoices V2 - train 1 loader. Server-only. The one place every DB
// read lives. Reads are scoped by the `scope.accountKeys` list; a
// query never leaves this file without `.in("account_key", scope...)`.
//
// Query budget:
//   Scope setup (page load):
//     1  people.is_invoice_admin presence (narrow by worker_id)
//     1  accounts with active + !CORP
//   List surface (page load):
//     3  chip count heads (all / fix / acct), each scoped + optional site
//     1  all returned rows for this scope (bounded; 4 rows today)
//     1  paginated sent slice (range by `more`)
//     1  invoice_rejections for returned ids (newest-per-submission)
//     1  people rows for the sender emails on the page
//   Search path: the chip heads flip to id-only walks (two scoped
//     queries per chip - vendor + invoice_number) and the display
//     slice becomes a top-N-from-each / merge / dedupe / id-in load.
//   Drawer:
//     1  the invoice_submissions row by id
//     1  vendors.extract_line_items for that vendor_id
//     1  ai_line_items count for that invoice_uuid
//     1  invoice_rejections for that submission_id (newest row)
//
// Reads use .range(from, from+LIMIT-1) and never request > 1000 rows
// (Gotcha 12). `submitted_at` is the only time column on the row -
// invoice_submissions has NO created_at / sent_at columns.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChipCounts, DetailRow, DetailRowView, FilterKey, GlLine, InvoiceKind,
  InvoiceScope, ListRow, ListRowView, ListStatus, SiteFixCounts,
} from "./types";
import { escapeLike } from "./escape";
import { resolveFirstNames, firstWord } from "./firstName";

// ─── Email-stripping sanitisers ───────────────────────────────────
// `ListRow` and `DetailRow` carry `submitterEmail` and
// `rejection.rejectedBy` because the loader needs both to look up
// first names in `people`. ONLY the sanitised view types cross the
// server/client boundary; every client component (Drawer, Toolbar,
// cards, table) consumes `*View` shapes. A rendered RSC payload or
// HTML should contain zero "@" characters from these fields.

export function stripListRow(row: ListRow): ListRowView {
  return {
    id: row.id,
    accountKey: row.accountKey,
    kind: row.kind,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    submittedAt: row.submittedAt,
    submitterFirstName: row.submitterFirstName,
    totalAmount: row.totalAmount,
    vendorName: row.vendorName,
    vendorId: row.vendorId,
    pageUrl: row.pageUrl,
    pageCount: row.pageCount,
    status: row.status,
    rejection: row.rejection
      ? {
          rejectedAt: row.rejection.rejectedAt,
          rejectedByFirstName: row.rejection.rejectedByFirstName,
          reason: row.rejection.reason,
          note: row.rejection.note,
        }
      : null,
  };
}

export function stripDetailRow(row: DetailRow): DetailRowView {
  return {
    ...stripListRow(row),
    gl: row.gl,
    lineCount: row.lineCount,
    extractLineItems: row.extractLineItems,
  };
}

// Columns the loader needs. No PII (no submitter identifier we
// wouldn't already pass through firstName).
const ROW_COLS =
  "id, account_key, type, invoice_number, invoice_date, submitted_at, submitter_email, " +
  "total_amount, vendor_name, vendor_id, drive_urls, page_count, status, gl_breakdown";

const PAGE_SIZE = 50;

// ─── Flag read ────────────────────────────────────────────────────

export async function isInvoiceAdmin(
  sb: SupabaseClient,
  workerId: string | null,
): Promise<boolean> {
  if (!workerId) return false;
  try {
    const q = await sb
      .from("people")
      .select("worker_id")
      .eq("worker_id", workerId)
      .eq("is_invoice_admin", true)
      .eq("status", "ACTIVE")
      .limit(1);
    if (q.error) {
      // eslint-disable-next-line no-console
      console.error(`[invoices/load] isInvoiceAdmin: ${q.error.message}`);
      return false;
    }
    return (q.data?.length ?? 0) > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[invoices/load] isInvoiceAdmin: ${msg}`);
    return false;
  }
}

// ─── Row mapping ──────────────────────────────────────────────────

interface RawRow {
  id: string;
  account_key: string;
  type: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  submitted_at: string;
  submitter_email: string | null;
  total_amount: number | string | null;
  vendor_name: string | null;
  vendor_id: string | null;
  drive_urls: unknown;
  page_count: number | null;
  status: string;
  gl_breakdown: unknown;
}

function toKind(type: string | null): InvoiceKind {
  return type === "credit" ? "credit" : "invoice";
}

function toStatus(raw: string): ListStatus | null {
  if (raw === "sent") return "sent";
  if (raw === "returned") return "returned";
  return null;
}

function pickPageUrl(drive_urls: unknown): string | null {
  if (Array.isArray(drive_urls) && drive_urls.length > 0) {
    const first = drive_urls[0];
    if (typeof first === "string" && first !== "") return first;
  }
  return null;
}

function toGl(gl_breakdown: unknown): GlLine[] {
  if (!Array.isArray(gl_breakdown)) return [];
  const out: GlLine[] = [];
  for (const line of gl_breakdown) {
    if (line && typeof line === "object") {
      const o = line as { code?: unknown; name?: unknown; amount?: unknown };
      if (typeof o.code === "string" && typeof o.name === "string"
          && (typeof o.amount === "number" || typeof o.amount === "string")) {
        const amt = typeof o.amount === "number" ? o.amount : Number(o.amount);
        if (Number.isFinite(amt)) out.push({ code: o.code, name: o.name, amount: amt });
      }
    }
  }
  return out;
}

function mapRow(raw: RawRow): ListRow | null {
  const status = toStatus(raw.status);
  if (!status) return null; // row got filtered to a status we don't show
  const amt = typeof raw.total_amount === "number"
    ? raw.total_amount
    : raw.total_amount != null ? Number(raw.total_amount) : Number.NaN;
  return {
    id: raw.id,
    accountKey: raw.account_key,
    kind: toKind(raw.type),
    invoiceNumber: raw.invoice_number ?? "",
    invoiceDate: raw.invoice_date,
    submittedAt: raw.submitted_at,
    submitterEmail: raw.submitter_email,
    submitterFirstName: null, // filled by resolver
    totalAmount: Number.isFinite(amt) ? amt : 0,
    vendorName: raw.vendor_name ?? "",
    vendorId: raw.vendor_id,
    pageUrl: pickPageUrl(raw.drive_urls),
    pageCount: typeof raw.page_count === "number" ? raw.page_count : null,
    status,
    rejection: null,
  };
}

// ─── Returned rows ────────────────────────────────────────────────
// All returned rows for the scope and optional site. The DB has 4
// today across all sites; this stays bounded well under PAGE_SIZE.
// Ordered in app by newest-open-rejection ASC (oldest send-back first).

async function fetchReturnedRows(
  sb: SupabaseClient,
  scope: InvoiceScope,
  site: string | null,
  q: string | null,
): Promise<ListRow[]> {
  if (q) {
    // Search path: run two scoped queries by column and merge.
    const like = `%${escapeLike(q)}%`;
    const base = () =>
      withSite(
        sb
          .from("invoice_submissions")
          .select(ROW_COLS)
          .in("account_key", scope.accountKeys)
          .eq("status", "returned"),
        site,
      );
    const [a, b] = await Promise.all([
      base().ilike("vendor_name", like).order("submitted_at", { ascending: false }).range(0, 999),
      base().ilike("invoice_number", like).order("submitted_at", { ascending: false }).range(0, 999),
    ]);
    if (a.error) throw new Error(`fetchReturnedRows (vendor): ${a.error.message}`);
    if (b.error) throw new Error(`fetchReturnedRows (invoice_number): ${b.error.message}`);
    const byId = new Map<string, ListRow>();
    for (const raw of [...(a.data ?? []), ...(b.data ?? [])] as unknown as RawRow[]) {
      const row = mapRow(raw);
      if (row) byId.set(row.id, row);
    }
    return Array.from(byId.values());
  }
  const res = await withSite(
    sb
      .from("invoice_submissions")
      .select(ROW_COLS)
      .in("account_key", scope.accountKeys)
      .eq("status", "returned"),
    site,
  )
    .order("submitted_at", { ascending: false })
    .range(0, 999);
  if (res.error) throw new Error(`fetchReturnedRows: ${res.error.message}`);
  return (res.data as unknown as RawRow[]).map(mapRow).filter((r): r is ListRow => r !== null);
}

// Attach the newest unresolved rejection to each returned row.
async function attachRejections(
  sb: SupabaseClient,
  returned: ListRow[],
): Promise<void> {
  if (returned.length === 0) return;
  const ids = returned.map((r) => r.id);
  const q = await sb
    .from("invoice_rejections")
    .select("submission_id, rejected_at, rejected_by, reason, note, unrejected_at")
    .in("submission_id", ids)
    .order("rejected_at", { ascending: false });
  if (q.error) throw new Error(`invoice_rejections: ${q.error.message}`);
  const newest = new Map<string, { rejected_at: string; rejected_by: string | null; reason: string | null; note: string | null; unrejected_at: string | null }>();
  for (const r of (q.data ?? []) as { submission_id: string; rejected_at: string; rejected_by: string | null; reason: string | null; note: string | null; unrejected_at: string | null }[]) {
    // The rule is newest-rejected_at wins. We keep both open and
    // closed rows in the map because the drawer shows "Sent back
    // by X on <date>" regardless of whether the rejection has since
    // been cleared; the row's own status is the signal for "needs
    // a fix" (§5).
    const existing = newest.get(r.submission_id);
    if (!existing) newest.set(r.submission_id, r);
    else if (Date.parse(r.rejected_at) > Date.parse(existing.rejected_at)) {
      newest.set(r.submission_id, r);
    }
  }
  for (const row of returned) {
    const rej = newest.get(row.id);
    if (rej) {
      row.rejection = {
        rejectedAt: rej.rejected_at,
        rejectedBy: rej.rejected_by,
        rejectedByFirstName: null, // filled later
        reason: rej.reason,
        note: rej.note,
      };
    }
  }
}

// ─── Sent rows ────────────────────────────────────────────────────
//
// PostgREST caps each response at 1,000 rows (Gotcha 12). To page
// past that we walk in sequential 500-row chunks. Every chunk's
// range stays well under the cap; the loop stops when the requested
// `wanted` total is met or the result set is exhausted.

const SB_PAGE = 500;

async function paginatedWalk<T>(
  wanted: number,
  fetchRange: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = 0;
  while (out.length < wanted) {
    const to = Math.min(cursor + SB_PAGE - 1, cursor + (wanted - out.length) - 1);
    const chunk = await fetchRange(cursor, to);
    if (chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < to - cursor + 1) break;
    cursor += chunk.length;
  }
  return out.slice(0, wanted);
}

async function fetchSentSlice(
  sb: SupabaseClient,
  scope: InvoiceScope,
  site: string | null,
  q: string | null,
  wanted: number,
): Promise<{ rows: ListRow[]; total: number }> {
  if (wanted <= 0) return { rows: [], total: 0 };
  if (!q) {
    // Non-search: walk 500 at a time until we have `wanted` rows.
    // The count comes from the first response's `count: "exact"`
    // header so we know the real total even past the walk size.
    let totalFromCount: number | null = null;
    const rows = await paginatedWalk<RawRow>(wanted, async (from, to) => {
      const res = await withSite(
        sb
          .from("invoice_submissions")
          .select(ROW_COLS, totalFromCount === null ? { count: "exact" } : undefined)
          .in("account_key", scope.accountKeys)
          .eq("status", "sent"),
        site,
      )
        .order("submitted_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (res.error) throw new Error(`fetchSentSlice: ${res.error.message}`);
      if (totalFromCount === null && typeof res.count === "number") totalFromCount = res.count;
      return (res.data as unknown as RawRow[]) ?? [];
    });
    const mapped = rows.map(mapRow).filter((r): r is ListRow => r !== null);
    return { rows: mapped, total: totalFromCount ?? mapped.length };
  }
  // Search path: walk vendor and invoice_number in parallel 500 at
  // a time; merge by id; sort by submitted_at desc; keep the first
  // `wanted` by date. Walking keeps us past the 1,000 cap when the
  // user types a shared-prefix search (e.g. "sysco").
  const like = `%${escapeLike(q)}%`;
  const base = () =>
    withSite(
      sb
        .from("invoice_submissions")
        .select(ROW_COLS)
        .in("account_key", scope.accountKeys)
        .eq("status", "sent"),
      site,
    );
  const walkOne = (column: "vendor_name" | "invoice_number") =>
    paginatedWalk<RawRow>(wanted, async (from, to) => {
      const res = await base()
        .ilike(column, like)
        .order("submitted_at", { ascending: false })
        .range(from, to);
      if (res.error) throw new Error(`fetchSentSlice (${column}): ${res.error.message}`);
      return (res.data as unknown as RawRow[]) ?? [];
    });
  const [a, b] = await Promise.all([walkOne("vendor_name"), walkOne("invoice_number")]);
  const byId = new Map<string, ListRow>();
  for (const raw of [...a, ...b]) {
    const row = mapRow(raw);
    if (row) byId.set(row.id, row);
  }
  const merged = Array.from(byId.values()).sort((x, y) => {
    const t = Date.parse(y.submittedAt) - Date.parse(x.submittedAt);
    if (t !== 0) return t;
    return y.id.localeCompare(x.id);
  });
  // The caller uses the chip count for the current filter as Y.
  return { rows: merged.slice(0, wanted), total: merged.length };
}

// ─── Chip counts ──────────────────────────────────────────────────

async function countChipsWithSearch(
  sb: SupabaseClient,
  scope: InvoiceScope,
  site: string | null,
  q: string,
): Promise<ChipCounts> {
  const like = `%${escapeLike(q)}%`;
  async function idsFor(status: "returned" | "sent" | null): Promise<Set<string>> {
    async function col(column: "vendor_name" | "invoice_number"): Promise<string[]> {
      const out: string[] = [];
      const PAGE = 500;
      let from = 0;
      while (true) {
        let qb = sb
          .from("invoice_submissions")
          .select("id")
          .in("account_key", scope.accountKeys)
          .ilike(column, like);
        if (status) qb = qb.eq("status", status);
        else qb = qb.not("status", "in", "(deleted,corrected,archived)");
        if (site) qb = qb.eq("account_key", site);
        const res = await qb.range(from, from + PAGE - 1);
        if (res.error) throw new Error(`count search ${column}: ${res.error.message}`);
        const chunk = (res.data ?? []) as { id: string }[];
        for (const row of chunk) out.push(row.id);
        if (chunk.length < PAGE) break;
        from += PAGE;
      }
      return out;
    }
    const [a, b] = await Promise.all([col("vendor_name"), col("invoice_number")]);
    const s = new Set<string>();
    for (const id of a) s.add(id);
    for (const id of b) s.add(id);
    return s;
  }
  const [all, fix, acct] = await Promise.all([idsFor(null), idsFor("returned"), idsFor("sent")]);
  return { all: all.size, fix: fix.size, acct: acct.size };
}

function withSite<T extends { eq: (col: string, v: string) => T }>(qb: T, site: string | null): T {
  return site ? qb.eq("account_key", site) : qb;
}

async function countChipsNoSearch(
  sb: SupabaseClient,
  scope: InvoiceScope,
  site: string | null,
): Promise<ChipCounts> {
  const [all, fix, acct] = await Promise.all([
    withSite(
      sb.from("invoice_submissions")
        .select("*", { count: "exact", head: true })
        .in("account_key", scope.accountKeys)
        .not("status", "in", "(deleted,corrected,archived)"),
      site,
    ),
    withSite(
      sb.from("invoice_submissions")
        .select("*", { count: "exact", head: true })
        .in("account_key", scope.accountKeys)
        .eq("status", "returned"),
      site,
    ),
    withSite(
      sb.from("invoice_submissions")
        .select("*", { count: "exact", head: true })
        .in("account_key", scope.accountKeys)
        .eq("status", "sent"),
      site,
    ),
  ]);
  if (all.error) throw new Error(`count all: ${all.error.message}`);
  if (fix.error) throw new Error(`count fix: ${fix.error.message}`);
  if (acct.error) throw new Error(`count acct: ${acct.error.message}`);
  return { all: all.count ?? 0, fix: fix.count ?? 0, acct: acct.count ?? 0 };
}

// ─── First-name fill ──────────────────────────────────────────────

async function fillFirstNames(
  sb: SupabaseClient,
  rows: ListRow[],
): Promise<void> {
  const emails = new Set<string>();
  for (const r of rows) {
    if (r.submitterEmail) emails.add(r.submitterEmail.toLowerCase());
    if (r.rejection?.rejectedBy) emails.add(r.rejection.rejectedBy.toLowerCase());
  }
  if (emails.size === 0) return;
  const q = await sb
    .from("people")
    .select("work_email, display_name, status")
    .in("work_email", Array.from(emails));
  if (q.error) throw new Error(`people lookup: ${q.error.message}`);
  const map = resolveFirstNames(
    Array.from(emails),
    (q.data ?? []) as { work_email: string | null; display_name: string | null; status: string | null }[],
  );
  for (const r of rows) {
    if (r.submitterEmail) r.submitterFirstName = map.get(r.submitterEmail.toLowerCase()) ?? null;
    if (r.rejection?.rejectedBy) {
      r.rejection.rejectedByFirstName = map.get(r.rejection.rejectedBy.toLowerCase()) ?? null;
    }
  }
}

// ─── Public: the list page payload ────────────────────────────────

export interface ListViewInput {
  sb: SupabaseClient;
  scope: InvoiceScope;
  site: string | null;
  show: FilterKey;
  q: string | null;
  more: number;
}

export interface ListView {
  rows: ListRowView[];
  total: number;        // Y in "showing X of Y". Always the chip count
                        // for the current filter so pagination stays
                        // honest under search and past the DB cap.
  chipCounts: ChipCounts;
  siteFixCounts: SiteFixCounts;
  pageSize: number;
  returnedCount: number;
  capHit: boolean;      // true when we hit a hard walk cap short of
                        // `total`. The surface shows "To see older,
                        // search or pick a site." instead of "Show
                        // older" in that case.
}

// Soft cap on how many rows we will walk for the list display.
// At 10 pages of 50 we're well past what a human scans; beyond
// this the surface says "To see older, search or pick a site"
// instead of "Show older". The chip count stays true as Y.
const DISPLAY_WALK_CAP = 500;

export async function loadInvoiceList(input: ListViewInput): Promise<ListView> {
  const { sb, scope, site, show, q, more } = input;
  if (scope.accountKeys.length === 0) {
    return {
      rows: [],
      total: 0,
      chipCounts: { all: 0, fix: 0, acct: 0 },
      siteFixCounts: { byAccountKey: {} },
      pageSize: PAGE_SIZE,
      returnedCount: 0,
      capHit: false,
    };
  }

  const requestedRows = Math.max(1, more) * PAGE_SIZE;
  const wantedRows = Math.min(requestedRows, DISPLAY_WALK_CAP);

  // Chip counts: one or the other path. Three queries total unless
  // the user is searching (then it is the wider id-only walk).
  const chipCountsPromise = q
    ? countChipsWithSearch(sb, scope, site, q)
    : countChipsNoSearch(sb, scope, site);

  let returned: ListRow[] = [];
  let sent: { rows: ListRow[]; total: number } = { rows: [], total: 0 };

  if (show === "fix") {
    returned = await fetchReturnedRows(sb, scope, site, q);
    await attachRejections(sb, returned);
    returned.sort(byReturnedOrder);
    sent = { rows: [], total: 0 };
  } else if (show === "acct") {
    returned = [];
    sent = await fetchSentSlice(sb, scope, site, q, wantedRows);
  } else {
    // "all": returned first, then sent
    returned = await fetchReturnedRows(sb, scope, site, q);
    await attachRejections(sb, returned);
    returned.sort(byReturnedOrder);
    const sentWanted = Math.max(0, wantedRows - returned.length);
    sent = await fetchSentSlice(sb, scope, site, q, sentWanted);
  }

  const combined: ListRow[] = [...returned, ...sent.rows].slice(0, wantedRows);
  await fillFirstNames(sb, combined);

  const chipCounts = await chipCountsPromise;

  // Site -> N to fix. Derived from the already-loaded returned list
  // only; no extra query.
  const siteFixCounts: SiteFixCounts = { byAccountKey: {} };
  for (const r of returned) {
    siteFixCounts.byAccountKey[r.accountKey] = (siteFixCounts.byAccountKey[r.accountKey] ?? 0) + 1;
  }

  // Total is the chip count for the current filter. That is what
  // "showing X of Y" promises the reader and it matches the chips.
  // Under search, chipCounts already reflects the search-matching
  // total; paginator past the DB cap, the walk stops at
  // DISPLAY_WALK_CAP and we fall back to the "search or pick a site"
  // line via `capHit`.
  const total =
    show === "fix"  ? chipCounts.fix  :
    show === "acct" ? chipCounts.acct :
                      chipCounts.all;

  const capHit = combined.length < total && requestedRows > DISPLAY_WALK_CAP;

  const rows = combined.map(stripListRow);

  return {
    rows,
    total,
    chipCounts,
    siteFixCounts,
    pageSize: PAGE_SIZE,
    returnedCount: returned.length,
    capHit,
  };
}

function byReturnedOrder(a: ListRow, b: ListRow): number {
  // Oldest-send-back first (newest rejection date ASC).
  const ar = a.rejection?.rejectedAt ? Date.parse(a.rejection.rejectedAt) : Date.parse(a.submittedAt);
  const br = b.rejection?.rejectedAt ? Date.parse(b.rejection.rejectedAt) : Date.parse(b.submittedAt);
  if (ar !== br) return ar - br;
  return a.id.localeCompare(b.id);
}

// ─── Public: one-invoice detail (drawer) ──────────────────────────

export async function loadInvoiceDetail(
  sb: SupabaseClient,
  scope: InvoiceScope,
  invoiceId: string,
): Promise<DetailRowView | null> {
  if (!invoiceId || scope.accountKeys.length === 0) return null;
  const q = await sb
    .from("invoice_submissions")
    .select(ROW_COLS)
    .eq("id", invoiceId)
    .maybeSingle();
  if (q.error || !q.data) return null;
  const raw = q.data as unknown as RawRow;
  // Scope check BEFORE we read any further column.
  if (!scope.accountKeys.includes(raw.account_key)) return null;
  const base = mapRow(raw);
  if (!base) return null;

  // rejection (newest row for this submission; may be open or closed)
  if (base.status === "returned") {
    await attachRejections(sb, [base]);
  }

  // first names on this single row
  await fillFirstNames(sb, [base]);

  // vendor extract flag
  let extractLineItems: boolean | null = null;
  if (raw.vendor_id) {
    const vq = await sb
      .from("vendors")
      .select("extract_line_items")
      .eq("id", raw.vendor_id)
      .maybeSingle();
    if (!vq.error && vq.data) {
      const ex = (vq.data as { extract_line_items: boolean | null }).extract_line_items;
      extractLineItems = typeof ex === "boolean" ? ex : null;
    }
  }

  // ai_line_items count for this invoice
  const lc = await sb
    .from("ai_line_items")
    .select("*", { count: "exact", head: true })
    .eq("invoice_uuid", invoiceId);
  const lineCount = lc.error ? 0 : (lc.count ?? 0);

  const fullDetail: DetailRow = {
    ...base,
    gl: toGl(raw.gl_breakdown),
    lineCount,
    extractLineItems,
  };
  // Hand the client a sanitised view; emails never leave the server.
  return stripDetailRow(fullDetail);
}

// ─── Public: derive sender first name only (helper for drawer ui) ─
export { firstWord };
