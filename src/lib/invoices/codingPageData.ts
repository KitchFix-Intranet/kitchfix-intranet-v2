// Pure. The data the coding page (and the email body) draws.
//
// What appears:
//   - site (account key), vendor, kind (invoice / credit),
//     invoice number, invoice date,
//     total (displayed positive, two decimals, thousands commas),
//     each coding line (code, name, amount),
//     who sent it (first name + last initial from the `people`
//     row - correction 6: the byline is left off when there is
//     no row; a name is never built from an email address),
//     when it was sent,
//     "[TEST]" above the title in test mode (correction 8).
//
// The PDF renderer in buildOutboundPdf.ts reads this shape; so
// does the email body (so both are built from the same facts).
// No dollar amount leaves this function in a context other than
// the total and the coding amounts.

export interface CodingPageInvoiceInput {
  account_key: string;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;         // ISO date-only
  total_amount: number;         // may be negative for credit, as stored
  type: "invoice" | "credit";
  gl_breakdown: ReadonlyArray<{ code: string; name: string; amount: number }>;
  submitted_at: string;         // ISO timestamp
}

export interface CodingPageSubmitter {
  first_name: string | null;
  last_initial: string | null; // single letter, no dot
}

export interface CodingPageData {
  isTest: boolean;
  title: string;
  site: string;
  vendor: string;
  kindLabel: string;            // "Invoice" | "Credit"
  numberLabel: string;          // "Invoice number" | "Credit number"
  number: string;
  dateLabel: string;            // "Invoice date" | "Credit date"
  dateDisplay: string;          // MM/DD/YYYY
  totalLabel: string;           // "Total" | "Credit total"
  totalDisplay: string;         // $1,234.56
  lines: ReadonlyArray<{ code: string; name: string; amountDisplay: string }>;
  byline: string | null;        // "Jane D" or null when no people row
  whenDisplay: string;          // MM/DD/YYYY HH:MM
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function formatMoney(nAbs: number): string {
  const cents = Math.round(nAbs * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  const withCommas = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}.${pad2(frac)}`;
}

function formatDateMDY(iso: string): string {
  // Expect YYYY-MM-DD. String-slice; no Date math so no timezone shift.
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
}

function formatWhen(iso: string): string {
  // ISO timestamp. Use UTC parts so output is stable and
  // repo-public-friendly (no site-locale leak).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const y = d.getUTCFullYear();
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  return `${m}/${day}/${y} ${hh}:${mm} UTC`;
}

function bylineOf(s: CodingPageSubmitter): string | null {
  // Correction 6: no name derived from an email. If people has
  // no row, the byline is left off.
  const first = (s.first_name ?? "").trim();
  const last = (s.last_initial ?? "").trim();
  if (first === "") return null;
  if (last === "") return first;
  return `${first} ${last.charAt(0).toUpperCase()}`;
}

export function buildCodingPageData(
  invoice: CodingPageInvoiceInput,
  submitter: CodingPageSubmitter,
  mode: "test" | "live",
): CodingPageData {
  const isTest = mode === "test";
  const isCredit = invoice.type === "credit";
  const title = isCredit ? "Credit" : "Invoice";

  return {
    isTest,
    title,
    site: invoice.account_key,
    vendor: invoice.vendor_name,
    kindLabel: title,
    numberLabel: isCredit ? "Credit number" : "Invoice number",
    number: invoice.invoice_number,
    dateLabel: isCredit ? "Credit date" : "Invoice date",
    dateDisplay: formatDateMDY(invoice.invoice_date),
    totalLabel: isCredit ? "Credit total" : "Total",
    totalDisplay: formatMoney(Math.abs(invoice.total_amount)),
    lines: invoice.gl_breakdown.map((l) => ({
      code: l.code,
      name: l.name,
      amountDisplay: formatMoney(Math.abs(l.amount)),
    })),
    byline: bylineOf(submitter),
    whenDisplay: formatWhen(invoice.submitted_at),
  };
}
