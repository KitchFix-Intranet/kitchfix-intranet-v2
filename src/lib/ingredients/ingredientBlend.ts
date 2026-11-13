// M2.1: one pipeline for "this ingredient's blend and each item's
// status". Lifted verbatim from the per-master loop in
// IngredientMasters.tsx (byte-identical semantics) so every door into
// the detail panel - Ingredients tab, Review queue, /api/review/item,
// /api/review/ingredient - reads one shape.
//
// Inputs: the ingredient (for base_unit), the set of items that feed
// the blend (the confirmed + live set when callers want the "real"
// blend; or that set plus a hypothetical joiner when callers want the
// joiner's status), and the ingredient's measures list.
//
// Outputs:
//   - three lens rollups (blended, standard, premium), each with the
//     spend-weighted survivor mean, min/max, pricedCount, linkedCount,
//     usd12m, unpricedUsd;
//   - per-item status (in_blend / check_it / needs_measure /
//     sizes_differ), keyed by item id;
//   - per-item perBaseInIngUnit (null when no reach);
//   - the sets that drove each status.
//
// The caller decides whether a viewed item is in the blend set or a
// hypothetical joiner:
//   - If the item is confirmed+live, pass it inside `items`. Its
//     statusKind comes straight from the single pipeline run.
//   - If the item is proposed (or archived, or any non-live state),
//     the blend value shown to the user stays the confirmed-set run
//     (call the function once with just confirmed items). Then run
//     the function a SECOND TIME with confirmed+{viewed}, and read
//     the viewed item's statusKind from the second run. This matches
//     the M2.1 rule "status is what it would be if it joined".

import {
  buildLensStats,
  blendStats,
  type BlendItem,
  type LensStats,
} from "./blend";
import {
  priceInUnit,
  sizesDifferFlags,
  type Measure,
} from "./measures";
import { canonicalFromBaseUnit } from "./pack";

// "LIVE_STATUSES" names the vendor_item.status values the Ingredients
// tab's rollup includes. Exported here so callers (API routes, the
// Review queue) query the same set without a second source of truth.
export const LIVE_STATUSES: readonly string[] = ["active", "resale"];

export type BlendStatus = "in_blend" | "check_it" | "needs_measure" | "sizes_differ";

// Minimum shape the pipeline consumes. Mirrors the pr_vendor_items
// columns IngredientMasters already selects; the two API routes pass
// the same shape after their own reads.
export type BlendInputItem = {
  id: string;
  grade: string | null;
  usd12m: number;
  perBase: number | null;
  perBaseUom: string | null;
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  caseWeightLb: number | null;
};

export type IngredientBlendResult = {
  blendedLens: LensStats;
  standardLens: LensStats;
  premiumLens: LensStats;
  // Union of per-grade exclusions (the blended lens's outliers).
  excludedIds: Set<string>;
  // Count-costed ingredients: sized packs whose piece sizes disagree
  // within one kind. Priced, shown, NOT in any lens.
  sizesDifferIds: Set<string>;
  // Items that cannot reach base_unit through the measures.
  needsMeasureIds: Set<string>;
  // Per-item price in the ingredient's base_unit; null when no reach.
  perBaseInIngUnit: Map<string, number | null>;
  // Per-item status; the one source every surface reads.
  statusKindById: Map<string, BlendStatus>;
};

export function computeIngredientBlend(
  ingredient: { base_unit: string },
  items: readonly BlendInputItem[],
  measures: readonly Measure[],
): IngredientBlendResult {
  const masterUom = canonicalFromBaseUnit(ingredient.base_unit);

  // M2 R2 rule 2: sized packs whose piece sizes disagree within one
  // kind - priced, shown, not in any lens. Flagged BEFORE the outlier
  // rule runs. Only fires for count-costed ingredients.
  const sizesDifferIds = sizesDifferFlags(
    items.map((it) => ({
      id: it.id,
      packQty: it.packQty,
      packSize: it.packSize,
      packUom: it.packUom,
    })),
    measures,
    ingredient.base_unit,
  );

  const needsMeasureIds = new Set<string>();
  const perBaseInIngUnit = new Map<string, number | null>();
  const priced: Array<{ id: string; v: number; grade: string | null; usd: number }> = [];

  for (const it of items) {
    const rawN = it.perBase != null ? Number(it.perBase) : NaN;
    const storedUom = it.perBaseUom ?? null;
    if (!Number.isFinite(rawN) || rawN <= 0) {
      perBaseInIngUnit.set(it.id, null);
      continue;
    }
    if (masterUom && storedUom) {
      const result = priceInUnit(
        {
          perBase: rawN,
          baseUom: storedUom,
          packQty: it.packQty,
          packSize: it.packSize,
          packUom: it.packUom,
          caseWeightLb: it.caseWeightLb,
        },
        masterUom,
        { measures },
      );
      if (result == null) {
        needsMeasureIds.add(it.id);
        perBaseInIngUnit.set(it.id, null);
      } else if (sizesDifferIds.has(it.id)) {
        // Priced, shown, not in the blend; keep the number but do not
        // push into `priced`.
        perBaseInIngUnit.set(it.id, result.per);
      } else {
        priced.push({ id: it.id, v: result.per, grade: it.grade, usd: it.usd12m });
        perBaseInIngUnit.set(it.id, result.per);
      }
    } else if (storedUom && !masterUom) {
      // Unusual ingredient.base_unit text; fall back to raw per_base.
      priced.push({ id: it.id, v: rawN, grade: it.grade, usd: it.usd12m });
      perBaseInIngUnit.set(it.id, rawN);
    } else {
      priced.push({ id: it.id, v: rawN, grade: it.grade, usd: it.usd12m });
      perBaseInIngUnit.set(it.id, rawN);
    }
  }

  // M2 §2.2: the blended lens runs the outlier rule PER GRADE and
  // unions the survivor sets. Standard / Premium lenses stay
  // partition-first (filter then run once).
  const blendInputs: BlendItem[] = priced;
  const itemsForLens = items.map((it) => ({
    id: it.id,
    usd_12m: it.usd12m,
    grade: it.grade,
  }));
  const blendedLens = buildLensStats(blendInputs, itemsForLens, "blended");
  const standardLens = buildLensStats(blendInputs, itemsForLens, "standard");
  const premiumLens = buildLensStats(blendInputs, itemsForLens, "premium");

  // Union of per-grade exclusions drives the per-item "check_it"
  // (outlier) status. Pre-M2 this was a single blendStats call; M2
  // runs it per grade and unions the exclusion sets so a premium far
  // from the standard median is not flagged when it is in line with
  // its own grade's peers.
  const excludedIds = new Set<string>();
  {
    const buckets: Record<"premium" | "standard", BlendItem[]> = { premium: [], standard: [] };
    for (const p of priced) {
      buckets[p.grade === "premium" ? "premium" : "standard"].push(p);
    }
    for (const g of ["premium", "standard"] as const) {
      const s = blendStats(buckets[g]);
      for (const id of s.excluded) excludedIds.add(id);
    }
  }

  // Per-item status: four mutually exclusive kinds in the same
  // precedence as IngredientMasters (needs_measure beats sizes_differ
  // beats check_it beats in_blend).
  const statusKindById = new Map<string, BlendStatus>();
  for (const it of items) {
    const kind: BlendStatus = needsMeasureIds.has(it.id)
      ? "needs_measure"
      : sizesDifferIds.has(it.id)
        ? "sizes_differ"
        : excludedIds.has(it.id)
          ? "check_it"
          : "in_blend";
    statusKindById.set(it.id, kind);
  }

  return {
    blendedLens,
    standardLens,
    premiumLens,
    excludedIds,
    sizesDifferIds,
    needsMeasureIds,
    perBaseInIngUnit,
    statusKindById,
  };
}
