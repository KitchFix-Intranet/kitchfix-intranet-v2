// M1 R2 fix 1: ONE shared helper. Every producer of the legacy-shaped
// fields the five display sites feed into deriveRecipePrice calls one
// of these two functions in measures-world; they derive the legacy
// shape from the new tables so the display pipeline sees the new
// numbers without any JSX edit.
//
// shapeIngredientEachFromMeasures: the ingredient's
// each_measure_qty/uom/source come from its count-to-weight row,
// else its count-to-volume row, else null.
//
// shapeItemEachFromCaseWeight: the item's eachMeasure is derived
// directly from case_weight_lb when the pack is count-based, by
// dividing the case weight by the count. For a volume pack or any
// non-count pack the item's eachMeasure is null (prompt §2.2
// amendment: case_weight_lb only derives an eachMeasure for a count
// pack; the item's own legacy each_measure columns are NOT read in
// the measures world).

import type { Measure } from "./measures";
import { DIM_BY_UOM, TO_BASE } from "./pack";

export function shapeIngredientEachFromMeasures(
  measures: readonly Measure[],
): { qty: number | null; uom: string | null; source: string | null } {
  const isCountToDim = (m: Measure, dim: "weight" | "volume"): boolean => {
    const fd = DIM_BY_UOM[m.from_unit.toUpperCase()];
    const td = DIM_BY_UOM[m.to_unit.toUpperCase()];
    return fd === "count" && td === dim;
  };
  const countToWeight = measures.find((m) => isCountToDim(m, "weight"));
  const pick = countToWeight ?? measures.find((m) => isCountToDim(m, "volume"));
  if (!pick) return { qty: null, uom: null, source: null };
  return {
    qty: Number(pick.qty),
    uom: pick.to_unit.toUpperCase(),
    source: pick.source,
  };
}

// Count packs only. Matches migration 0019 §4b's inverse: the migration
// built case_weight_lb as (count * weight_of_one); this helper divides
// back to recover weight_of_one for display.
const COUNT_PACK_UOMS: ReadonlySet<string> = new Set<string>(["EA", "CT", "PC", "DZ"]);
const PACK_UOM_MULT: Record<string, number> = { EA: 1, CT: 1, PC: 1, DZ: 12 };

// M1 R3 fix 2: in the measures world, case_weight_lb decides WHETHER
// the item has an override and WHAT IT IS WORTH. The legacy
// each_measure_qty/uom pair, when present and consistent with the
// case weight, decides HOW TO SHOW IT.
//
// Rules:
//   1. No case weight, or not a count pack -> null (no override).
//   2. Legacy qty + uom are both set, uom is a weight unit, and
//      count * (legacy in lb) is within 1 percent of case_weight_lb
//      -> return the legacy pair AS TYPED (e.g. "2.5 OZ" stays
//      "2.5 OZ", not "0.15624 LB").
//   3. Otherwise -> derived shape: under 1 lb -> round to 2 dp in OZ;
//      at or above 1 lb -> round to 2 dp in LB. This is the display
//      form for a freshly-written case weight that has no matching
//      legacy pair (a user typed the case weight directly, or an
//      earlier edit changed legacy without case weight and got
//      superseded).
export function shapeItemEachFromCaseWeight(
  caseWeightLb: number | null,
  packQty: number | null,
  packSize: number | null,
  packUom: string | null,
  legacyQty: number | null,
  legacyUom: string | null,
): { qty: number; uom: string } | null {
  if (caseWeightLb == null || !Number.isFinite(caseWeightLb) || caseWeightLb <= 0) return null;
  const pu = (packUom ?? "").toUpperCase();
  if (!COUNT_PACK_UOMS.has(pu)) return null;
  const q = Number(packQty ?? 1) || 1;
  const s = Number(packSize ?? 1) || 1;
  const mult = PACK_UOM_MULT[pu] ?? 1;
  const count = q * s * mult;
  if (!(count > 0)) return null;

  // Rule 2: preserve legacy display when it agrees.
  if (
    legacyQty != null &&
    Number.isFinite(legacyQty) &&
    legacyQty > 0 &&
    legacyUom
  ) {
    const lu = legacyUom.toUpperCase();
    if (DIM_BY_UOM[lu] === "weight") {
      const lf = TO_BASE[lu];
      if (lf != null && lf > 0) {
        const expectedLb = count * legacyQty * lf;
        const diff = Math.abs(expectedLb - caseWeightLb);
        if (diff / caseWeightLb <= 0.01) {
          return { qty: Number(legacyQty), uom: lu };
        }
      }
    }
  }

  // Rule 3: derived shape with unit choice + rounding.
  const perOneLb = caseWeightLb / count;
  if (perOneLb < 1) {
    const perOneOz = perOneLb * 16;
    return { qty: round2(perOneOz), uom: "OZ" };
  }
  return { qty: round2(perOneLb), uom: "LB" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
