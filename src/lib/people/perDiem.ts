// T4b-2 (2026-11-14). Travel per-diem tiers + server-side totals.
//
// Ported from v1 PAFForm.js:
//   - PER_DIEM_TIERS (lines 652-660)
//   - travel totals computation (lines 1030-1049)
//
// Tier keys match v1's: a draft saves one count per tier, same
// key names, so recordDetail reads old and new records the same
// way. v2 adds `perDiemDays` as an array of { date, tier } so a
// draft reopens with each day as it was left.

export interface PerDiemTier {
  key: string;        // suffix after "perDiem_" in the stored field
  label: string;      // option label in the dropdown
  rate: number;       // dollars per day
  desc: string;       // option sublabel
}

export const PER_DIEM_TIERS: readonly PerDiemTier[] = [
  { key: "noMeals",        label: "No meals provided",             rate: 80, desc: "Full day away from site" },
  { key: "bkfstProvided",  label: "Breakfast provided",            rate: 65, desc: "Lunch & dinner on your own" },
  { key: "lunchProvided",  label: "Lunch provided",                rate: 60, desc: "Breakfast & dinner on your own" },
  { key: "dinnerProvided", label: "Dinner provided",               rate: 45, desc: "Breakfast & lunch on your own" },
  { key: "bkfstLunch",     label: "Breakfast & lunch provided",    rate: 45, desc: "Default for on-site work" },
  { key: "bkfstDinner",    label: "Breakfast & dinner provided",   rate: 30, desc: "Lunch on your own" },
  { key: "lunchDinner",    label: "Lunch & dinner provided",       rate: 25, desc: "Breakfast on your own" },
  { key: "allMeals",       label: "All meals provided",            rate: 10, desc: "Incidentals only" },
] as const;

const TIER_KEYS: readonly string[] = PER_DIEM_TIERS.map((t) => t.key);
const TIER_RATE: Record<string, number> = Object.fromEntries(
  PER_DIEM_TIERS.map((t) => [t.key, t.rate]),
);

// A perDiemDays entry. `date` is a YYYY-MM-DD string. `tier` is
// one of the tier keys above; "" means no choice yet.
export interface PerDiemDay {
  date: string;
  tier: string;
}

// Trip days count. v1 line 1042.
export function tripDays(startISO: string, endISO: string): number {
  if (!startISO || !endISO) return 0;
  const s = Date.parse(`${startISO.slice(0, 10)}T00:00:00Z`);
  const e = Date.parse(`${endISO.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  if (e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

// Build the list of day dates from a start + end.
export function enumerateDays(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  if (!startISO || !endISO) return out;
  const d = new Date(`${startISO.slice(0, 10)}T00:00:00Z`);
  const stop = new Date(`${endISO.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime()) || isNaN(stop.getTime())) return out;
  while (d.getTime() <= stop.getTime()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${dd}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Server-authoritative totals, computed from the dates + per-day
// choices + supplement switch. The body's totals are ignored.
//
// Mirrors v1 PAFForm.js lines 1030-1049:
//   - travelTotalDays = full day count (start..end inclusive)
//   - perDiem_<tier>  = count of days at that tier (string, matching v1)
//   - perDiemTotal    = sum(count_i * rate_i)
//   - travelSupplementTotal = tripDays * 50 when enabled, else 0
//   - travelGrandTotal = perDiemTotal + travelSupplementTotal
//
// v1 did NOT set `amount` for travel (the record view reads
// `perDiemTotal` as the row's displayed amount instead). We leave
// `amount` as an empty string here for the same reason - setting
// it would create a divergence from existing rows.
export function computeTravelTotals(input: {
  startISO: string;
  endISO: string;
  perDiemDays: readonly PerDiemDay[];
  supplementEnabled: boolean;
}): Record<string, string> {
  const days = tripDays(input.startISO, input.endISO);
  const counts: Record<string, number> = {};
  for (const k of TIER_KEYS) counts[k] = 0;
  for (const d of input.perDiemDays) {
    if (!d.tier || !(d.tier in counts)) continue;
    counts[d.tier] += 1;
  }
  const perDiemTotal = TIER_KEYS.reduce((sum, k) => sum + counts[k] * TIER_RATE[k], 0);
  const sup = input.supplementEnabled ? days * 50 : 0;
  const grand = perDiemTotal + sup;
  // Shape matches v1: counts stored as strings under
  // "perDiem_<key>", totals as numbers (but we stringify for the
  // payload text column).
  const out: Record<string, string> = {
    travelTotalDays: String(days),
    perDiemTotal: perDiemTotal.toFixed(2),
    travelSupplementTotal: sup.toFixed(2),
    travelGrandTotal: grand.toFixed(2),
    travelSupplementEnabled: input.supplementEnabled ? "Yes" : "No",
  };
  for (const k of TIER_KEYS) out[`perDiem_${k}`] = String(counts[k]);
  return out;
}
