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
import { DIM_BY_UOM } from "./pack";

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

export function shapeItemEachFromCaseWeight(
  caseWeightLb: number | null,
  packQty: number | null,
  packSize: number | null,
  packUom: string | null,
): { qty: number; uom: "LB" } | null {
  if (caseWeightLb == null || !Number.isFinite(caseWeightLb) || caseWeightLb <= 0) return null;
  const pu = (packUom ?? "").toUpperCase();
  if (!COUNT_PACK_UOMS.has(pu)) return null;
  const q = Number(packQty ?? 1) || 1;
  const s = Number(packSize ?? 1) || 1;
  const mult = PACK_UOM_MULT[pu] ?? 1;
  const count = q * s * mult;
  if (!(count > 0)) return null;
  return { qty: caseWeightLb / count, uom: "LB" };
}
