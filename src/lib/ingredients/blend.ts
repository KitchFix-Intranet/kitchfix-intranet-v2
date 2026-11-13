// M2: one blend module. Pure, importable from server and client. The
// median-based outlier rule (3x / 1/3 of median, 3-item minimum), the
// spend-weighted mean, the zero-spend fallback, and the unweighted
// min/max over survivors all move here from
// src/components/ingredients/IngredientMasters.tsx (byte-identical).
//
// The single change in M2 is at the BLENDED lens: Premium is compared
// with Premium. Each grade group (premium vs. standard) runs its own
// median exclusion with its own 3-item minimum; the blended survivor
// set is the union of both groups' survivors. The Standard and Premium
// lenses stay partition-first (unchanged).

export const OUTLIER_RATIO = 3;
export const OUTLIER_MIN = 3;

export type Grade = "premium" | "standard";
export type Lens = "blended" | "standard" | "premium";

export type BlendItem = { id: string; v: number; usd: number; grade: string | null };

// LensStats mirrors the type in IngredientMastersFilter.tsx:50 so the
// existing readers (row header, strip, filter) see the same shape.
export type LensStats = {
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  pricedCount: number;
  linkedCount: number;
  usd12m: number;
  unpricedUsd: number;
};

export function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Normalise a grade token. Null and any non-"premium" value count as
// "standard" (per the original IngredientMasters rule).
export function gradeOf(raw: string | null | undefined): Grade {
  return raw === "premium" ? "premium" : "standard";
}

// Spend-weighted mean with zero-spend fallback to plain arithmetic
// mean. Byte-identical to the pre-M2 `weighted()` inner helper in
// IngredientMasters.tsx.
function weightedMean(xs: readonly { v: number; usd: number }[]): number | null {
  if (xs.length === 0) return null;
  let num = 0;
  let den = 0;
  for (const x of xs) {
    const u = Number.isFinite(x.usd) && x.usd > 0 ? x.usd : 0;
    num += x.v * u;
    den += u;
  }
  if (den > 0) return num / den;
  const sum = xs.reduce((a, b) => a + b.v, 0);
  return sum / xs.length;
}

// Core stats over a flat priced list. No grade partition here: callers
// decide the subset. Byte-identical semantics to the pre-M2 helper.
export function blendStats(priced: ReadonlyArray<{ id: string; v: number; usd: number }>): {
  median: number | null;
  survivorMean: number | null;
  survivorMin: number | null;
  survivorMax: number | null;
  excluded: Set<string>;
} {
  if (priced.length === 0) {
    return { median: null, survivorMean: null, survivorMin: null, survivorMax: null, excluded: new Set() };
  }
  const vals = priced.map((p) => p.v);
  const med = medianOf(vals);
  if (priced.length < OUTLIER_MIN) {
    return {
      median: med,
      survivorMean: weightedMean(priced),
      survivorMin: Math.min(...vals),
      survivorMax: Math.max(...vals),
      excluded: new Set(),
    };
  }
  const low = med / OUTLIER_RATIO;
  const high = med * OUTLIER_RATIO;
  const excluded = new Set<string>();
  const survivors: Array<{ v: number; usd: number }> = [];
  for (const p of priced) {
    if (p.v > high || p.v < low) excluded.add(p.id);
    else survivors.push({ v: p.v, usd: p.usd });
  }
  if (survivors.length === 0) {
    return { median: med, survivorMean: null, survivorMin: null, survivorMax: null, excluded };
  }
  const svals = survivors.map((s) => s.v);
  return {
    median: med,
    survivorMean: weightedMean(survivors),
    survivorMin: Math.min(...svals),
    survivorMax: Math.max(...svals),
    excluded,
  };
}

// M2 §2.2 ruling: the BLENDED lens runs the outlier rule per grade
// group and unions the survivor sets. A group with fewer than
// OUTLIER_MIN priced items excludes nothing.
//
// The STANDARD and PREMIUM lenses stay partition-first (filter then
// run blendStats once), byte-identical to d45d8db's buildLensStats.
//
// `items` is the raw unfiltered list so linkedCount and unpricedUsd
// describe the lens's whole population (same as pre-M2).
export function buildLensStats(
  priced: readonly BlendItem[],
  items: readonly { id: string; usd_12m: number | null; grade: string | null }[],
  lens: Lens,
): LensStats {
  if (lens === "blended") {
    return buildBlendedLens(priced, items);
  }
  return buildPartitionedLens(priced, items, lens);
}

function buildBlendedLens(
  priced: readonly BlendItem[],
  items: readonly { id: string; usd_12m: number | null; grade: string | null }[],
): LensStats {
  // Partition the priced items by grade; run the outlier rule in each
  // group; union the survivor sets. Standard: anything not "premium".
  const bucket: Record<Grade, BlendItem[]> = { premium: [], standard: [] };
  for (const p of priced) bucket[gradeOf(p.grade)].push(p);
  const excluded = new Set<string>();
  const survivors: BlendItem[] = [];
  for (const g of ["premium", "standard"] as const) {
    const s = blendStats(bucket[g]);
    for (const id of s.excluded) excluded.add(id);
    for (const p of bucket[g]) if (!s.excluded.has(p.id)) survivors.push(p);
  }
  if (survivors.length === 0) {
    // Degenerate: no priced items or every one was excluded (only
    // possible when a group exceeds OUTLIER_MIN and every member is
    // off-median, which the pre-M2 single-group version also handled
    // as "no survivors" → null mean).
    let subsetUsd = 0;
    let subsetUnpricedUsd = 0;
    const pricedIds = new Set(priced.map((p) => p.id));
    for (const it of items) {
      const u = Number(it.usd_12m ?? 0);
      subsetUsd += u;
      if (!pricedIds.has(it.id) || excluded.has(it.id)) subsetUnpricedUsd += u;
    }
    return {
      avgPerBase: null,
      minPerBase: null,
      maxPerBase: null,
      spreadRatio: null,
      pricedCount: 0,
      linkedCount: items.length,
      usd12m: subsetUsd,
      unpricedUsd: subsetUnpricedUsd,
    };
  }
  const sv = survivors.map((s) => ({ v: s.v, usd: s.usd }));
  const mean = weightedMean(sv);
  const vals = survivors.map((s) => s.v);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const spread = minV > 0 ? maxV / minV : null;
  const pricedIds = new Set(priced.map((p) => p.id));
  let subsetUsd = 0;
  let subsetUnpricedUsd = 0;
  for (const it of items) {
    const u = Number(it.usd_12m ?? 0);
    subsetUsd += u;
    if (!pricedIds.has(it.id) || excluded.has(it.id)) subsetUnpricedUsd += u;
  }
  return {
    avgPerBase: mean,
    minPerBase: minV,
    maxPerBase: maxV,
    spreadRatio: spread,
    pricedCount: priced.length - excluded.size,
    linkedCount: items.length,
    usd12m: subsetUsd,
    unpricedUsd: subsetUnpricedUsd,
  };
}

function buildPartitionedLens(
  priced: readonly BlendItem[],
  items: readonly { id: string; usd_12m: number | null; grade: string | null }[],
  lens: "standard" | "premium",
): LensStats {
  const subsetPriced = priced.filter((p) => gradeOf(p.grade) === lens);
  const s = blendStats(subsetPriced);
  const min = s.survivorMin;
  const max = s.survivorMax;
  const spread = min != null && max != null && min > 0 ? max / min : null;
  const pricedIdSet = new Set(subsetPriced.map((p) => p.id));
  let linkedCount = 0;
  let subsetUsd = 0;
  let subsetUnpricedUsd = 0;
  for (const it of items) {
    if (gradeOf(it.grade) !== lens) continue;
    linkedCount += 1;
    const itU = Number(it.usd_12m ?? 0);
    subsetUsd += itU;
    if (!pricedIdSet.has(it.id) || s.excluded.has(it.id)) subsetUnpricedUsd += itU;
  }
  const pricedCount = subsetPriced.length - s.excluded.size;
  return {
    avgPerBase: s.survivorMean,
    minPerBase: min,
    maxPerBase: max,
    spreadRatio: spread,
    pricedCount,
    linkedCount,
    usd12m: subsetUsd,
    unpricedUsd: subsetUnpricedUsd,
  };
}
