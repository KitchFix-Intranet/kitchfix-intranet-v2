// T4b-2 (2026-11-14). Pay bands table + helpers for the Pay
// increase recommendation sheet.
//
// Ported verbatim from v1's PAFForm.js:
//   - PAY_BANDS         lines 13-76
//   - STATE_ALIAS       line 79
//   - parseStateFromLocation  lines 81-88
//   - getBand            lines 78-83
//
// SERVER-ONLY. This module must not be imported from any client
// component. The /people/paf page passes the client only the two
// slices it needs:
//   1. The hourly bands for the person's state (one state).
//   2. The leadership bands (national).
// Nothing else - the whole table never reaches the browser.

export interface Band {
  min: number;
  mid: number;
  max: number;
}
export type Level = "hourly" | "leadership";

export const HOURLY_ROLES: readonly string[] = [
  "Dishwasher", "Cook", "FOH Attendant", "Driver", "Other",
] as const;
export const LEADERSHIP_ROLES: readonly string[] = [
  "Sous Chef", "Hospitality Manager", "Executive Chef", "General Manager", "Other",
] as const;

// Ported from v1 PAFForm.js:13-76. Hourly bands keyed by state,
// leadership bands national.
export const PAY_BANDS = {
  hourly: {
    AZ: {
      "Dishwasher":    { min: 15.50, mid: 17.50, max: 20.00 },
      "Cook":          { min: 18.00, mid: 21.00, max: 25.00 },
      "FOH Attendant": { min: 16.00, mid: 18.50, max: 22.00 },
      "Driver":        { min: 18.00, mid: 21.00, max: 25.00 },
    },
    FL: {
      "Dishwasher":    { min: 15.00, mid: 17.00, max: 19.50 },
      "Cook":          { min: 17.50, mid: 20.50, max: 24.00 },
      "FOH Attendant": { min: 15.50, mid: 18.00, max: 21.00 },
      "Driver":        { min: 17.50, mid: 20.50, max: 24.00 },
    },
    TX: {
      "Dishwasher":    { min: 15.00, mid: 17.00, max: 19.50 },
      "Cook":          { min: 18.00, mid: 21.00, max: 25.00 },
      "FOH Attendant": { min: 15.50, mid: 18.00, max: 21.00 },
      "Driver":        { min: 18.00, mid: 21.00, max: 25.00 },
    },
    NY: {
      "Dishwasher":    { min: 16.00, mid: 18.00, max: 20.00 },
      "Cook":          { min: 18.00, mid: 21.00, max: 25.00 },
      "FOH Attendant": { min: 16.50, mid: 19.00, max: 22.00 },
      "Driver":        { min: 18.00, mid: 21.00, max: 25.00 },
    },
    MO: {
      "Dishwasher":    { min: 15.00, mid: 17.00, max: 19.00 },
      "Cook":          { min: 17.00, mid: 20.00, max: 23.50 },
      "FOH Attendant": { min: 15.50, mid: 18.00, max: 21.00 },
      "Driver":        { min: 17.00, mid: 20.00, max: 23.50 },
    },
    OH: {
      "Dishwasher":    { min: 14.50, mid: 16.00, max: 18.00 },
      "Cook":          { min: 16.50, mid: 19.50, max: 23.00 },
      "FOH Attendant": { min: 14.50, mid: 17.00, max: 20.00 },
      "Driver":        { min: 16.50, mid: 19.50, max: 23.00 },
    },
    KY: {
      "Dishwasher":    { min: 14.00, mid: 15.50, max: 17.50 },
      "Cook":          { min: 16.00, mid: 18.50, max: 22.00 },
      "FOH Attendant": { min: 14.00, mid: 16.50, max: 19.50 },
      "Driver":        { min: 16.00, mid: 18.50, max: 22.00 },
    },
  } as Record<string, Record<string, Band>>,
  leadership: {
    "Sous Chef":           { min: 52000, mid: 60000, max: 72000 },
    "Hospitality Manager": { min: 55000, mid: 66000, max: 82000 },
    "Executive Chef":      { min: 80000, mid: 95000, max: 120000 },
    "General Manager":     { min: 80000, mid: 95000, max: 120000 },
  } as Record<string, Band>,
} as const;

// v1 line 79.
const STATE_ALIAS: Record<string, string> = { BUF: "NY" };

// Ported from v1 lines 81-88. `accounts.region` or a parse of the
// account key: pull the two-letter state from the second segment.
export function parseStateFromLocation(locationKey: string | null | undefined): string | null {
  if (!locationKey) return null;
  const segments = String(locationKey).split(" - ");
  const key = segments[0]?.trim();
  if (key === "CORP") return null;
  const raw = segments[1]?.trim();
  if (!raw) return null;
  return STATE_ALIAS[raw] ?? raw;
}

// Ported from v1 lines 78-83.
export function getBand(
  level: Level | "" | null,
  role: string | null,
  state: string | null,
): Band | null {
  if (!role || role === "Other") return null;
  if (level === "leadership") return PAY_BANDS.leadership[role] ?? null;
  if (!state || !PAY_BANDS.hourly[state]) return null;
  return PAY_BANDS.hourly[state][role] ?? null;
}

// The two slices passed to the client. Server-side only.
export interface ClientBands {
  state: string | null;
  hourly: Record<string, Band>;
  leadership: Record<string, Band>;
}
export function bandsForClient(accountKey: string | null, accountState: string | null): ClientBands {
  // Prefer the accounts.state column; fall back to parsing it from
  // the key (older account rows may not have state set).
  const state = (accountState ?? "").trim() || parseStateFromLocation(accountKey);
  const hourly = state && PAY_BANDS.hourly[state] ? PAY_BANDS.hourly[state] : {};
  return {
    state,
    hourly,
    leadership: PAY_BANDS.leadership as Record<string, Band>,
  };
}

// Server-authoritative dollar + percent difference between two
// rate strings. Used by the drafts API to overwrite the body's
// dollarIncrease + pctIncrease on every save.
export function computeRateIncrease(oldRateStr: string, newRateStr: string): {
  dollarIncrease: string;
  pctIncrease: string;
} {
  const o = Number(oldRateStr);
  const n = Number(newRateStr);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o <= 0) {
    return { dollarIncrease: "", pctIncrease: "" };
  }
  const d = n - o;
  const pct = (d / o) * 100;
  return {
    dollarIncrease: d.toFixed(2),
    pctIncrease: pct.toFixed(1),
  };
}
