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

export function formatWhen(iso: string): string {
  // 2.5: Central time, 12-hour, with the zone word CT.
  // Intl with timeZone "America/Chicago" handles daylight saving,
  // so a winter evening at 8:34 PM CST (= 02:34 UTC the next day)
  // and a summer evening at 8:34 PM CDT (= 01:34 UTC the next day)
  // both read "11/20/2026 8:34 PM CT" on the coding page and in
  // the email body.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Parts in the America/Chicago zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? "";
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod").toUpperCase();
  return `${month}/${day}/${year} ${hour}:${minute} ${dayPeriod} CT`;
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
