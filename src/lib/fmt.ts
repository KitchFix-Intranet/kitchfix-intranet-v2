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

export function fmtDate(
  iso: string | null,
  style: "short" | "long" | "time" = "short"
): string {
  if (!iso) return "-";
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
