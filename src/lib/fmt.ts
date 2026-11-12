// Shared formatting helpers. Chicago TZ for every date. No toLocaleString in
// components; no raw enum string in the UI; counts and dollars through here.

export const TZ = "America/Chicago";

function parts(iso: string): { y: number; m: number; d: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const bits = fmt.formatToParts(new Date(t));
  const y = Number(bits.find((b) => b.type === "year")?.value);
  const m = Number(bits.find((b) => b.type === "month")?.value);
  const d = Number(bits.find((b) => b.type === "day")?.value);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

// GOTCHA #4 companion: a date-only string ("2026-11-30") parses as UTC
// midnight and then formats in Chicago as the previous day. Any input
// without a time component (no "T") is formatted directly from its
// y/m/d parts and never round-tripped through a Date, so stored dates
// render the day they were stored. Timestamps (with "T" or a tz
// suffix) keep today's behaviour.
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function isDateOnly(iso: string): boolean { return !iso.includes("T"); }

export function fmtDate(
  iso: string | null,
  style: "short" | "long" | "time" = "short"
): string {
  if (!iso) return "-";
  // Date-only path: build the y/m/d directly from the string so the
  // Chicago TZ never shifts us back a day.
  if (isDateOnly(iso)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!y || !mo || !d) return iso;
    const todayY = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(new Date()),
    );
    if (style === "long") {
      // Degrade gracefully: no weekday on a date-only input (we would
      // need to parse-and-shift to know it, which is the exact bug we
      // are avoiding). Month + day + year is honest.
      return `${MONTHS_LONG[mo - 1]} ${d}, ${y}`;
    }
    if (style === "time") {
      // No time to show on a date-only input; render short.
      return y === todayY ? `${MONTHS_SHORT[mo - 1]} ${d}` : `${MONTHS_SHORT[mo - 1]} ${d}, ${y}`;
    }
    return y === todayY ? `${MONTHS_SHORT[mo - 1]} ${d}` : `${MONTHS_SHORT[mo - 1]} ${d}, ${y}`;
  }
  const p = parts(iso);
  if (!p) return iso;
  const t = Date.parse(iso);
  const todayY = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(new Date())
  );
  if (style === "long") {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(t));
  }
  if (style === "time") {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(t));
  }
  const includeYear = p.y !== todayY;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(new Date(t));
}

export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Whole calendar months elapsed between `iso` and "today" (Chicago).
// Uses the same Chicago-aware `parts()` helper that `fmtDate` uses, so
// a lastSeen of Jun 3 reads 5 months before Nov 11 regardless of local
// clock. 0 for a future date or a parse failure. Pure.
//
// Policy: whole months - the date 2025-11-11 relative to today
// 2026-11-11 returns 12; 2026-10-12 returns 0 (less than a month);
// 2026-10-11 returns 1 (same day-of-month at the one-month boundary).
export function monthsAgo(iso: string | null): number {
  if (!iso) return 0;
  const past = partsIn(iso);
  if (!past) return 0;
  const now = partsIn(new Date().toISOString());
  if (!now) return 0;
  let m = (now.y - past.y) * 12 + (now.m - past.m);
  if (now.d < past.d) m -= 1;
  return m < 0 ? 0 : m;
}

// Shared Chicago-aware (y, m, d) extractor. `parts()` above only
// accepts an ISO with a time component; this one normalises date-only
// strings the same way `fmtDate` does so both callers stay in sync.
function partsIn(iso: string): { y: number; m: number; d: number } | null {
  if (isDateOnly(iso)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!y || !mo || !d) return null;
    return { y, m: mo, d };
  }
  return parts(iso);
}

const NUM_FMT = new Intl.NumberFormat("en-US");

export function fmtCount(n: number): string {
  return NUM_FMT.format(Math.round(n));
}

export function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmtUsdLong(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${NUM_FMT.format(Math.round(abs))}`;
}

const STATUS_LABELS: Record<string, string> = {
  ok: "Completed",
  failed: "Failed",
  running: "Running",
};

export function fmtStatus(s: string): string {
  return STATUS_LABELS[s] ?? s;
}

// Pack-number display helpers (N13.1). Rounding happens on the way to the
// screen only; the stored `packNormalized` + raw pack_* columns the math
// readers (parsePackNormalized + packSegment) rely on stay exact.
//
// fmtPackNumber rounds one number to 2 decimals and drops trailing zeros.
// Integers stay whole. Returned as a string for interpolation.
//
// fmtPackNumbersInText walks a string and rounds every embedded decimal
// with 3+ fractional digits; numbers with 0, 1, or 2 decimals pass
// through (barcode / item-code / 2-dp dollar strings are unchanged).
export function fmtPackNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function fmtPackNumbersInText(s: string | null | undefined): string {
  if (!s) return s ?? "";
  return s.replace(/\d+\.\d{3,}/g, (m) => fmtPackNumber(Number(m)));
}

export function fmtDuration(startIso: string, endIso: string | null): string {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  if (m < 60) return r === 0 ? `${m} min` : `${m} min ${r} s`;
  const h = Math.floor(m / 60);
  const mr = m - h * 60;
  return mr === 0 ? `${h} h` : `${h} h ${mr} min`;
}
