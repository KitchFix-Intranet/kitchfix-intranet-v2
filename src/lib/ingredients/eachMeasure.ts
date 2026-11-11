// Derived recipe price for each-priced vendor items. Pure, importable
// from both server lib and client components (same RSC-boundary shape
// as categories.ts). Reads the shared vocabulary in pack.ts for TO_BASE
// and DIM_BY_UOM so adding a new unit there is the only edit needed to
// extend this helper's reach.
//
// N6 replaces N5's derivePerLb. The three rules still hold:
//   1. Derived at display, never stored. price_estimate.per_base stays
//      the price paid per each; nothing here writes.
//   2. No measure means no derived price. Null in, null out.
//   3. Only each-priced items convert. perBaseUom !== "EA" returns
//      null; lb-, fl oz-, gal-priced items keep their pre-N6 display.
//
// What changed from N5:
//   - The measure is (qty, uom), not a pounds-only number. The uom is
//     any weight or volume unit from WEIGHT_UOMS ∪ VOLUME_UOMS.
//   - A weight measure yields $ per LB; a volume measure yields $ per
//     GAL when the typed uom is one of { GAL, QT, L } (close to gallon
//     scale), otherwise per FLOZ (close to fl oz / pt / mL scale).
//     Both reach the result through TO_BASE in the conversion, so there
//     is one math, not two.
//   - Item measure wins over ingredient measure when both are set. Their
//     dimensions may differ.

import { DIM_BY_UOM, TO_BASE, convertPer } from "@/lib/ingredients/pack";

export type Measure = { qty: number; uom: string } | null;

function validMeasure(m: Measure): m is { qty: number; uom: string } {
  if (m == null) return false;
  if (!Number.isFinite(m.qty) || m.qty <= 0) return false;
  const u = m.uom.toUpperCase();
  const dim = DIM_BY_UOM[u];
  if (dim !== "weight" && dim !== "volume") return false;
  const factor = TO_BASE[u];
  return factor != null && Number.isFinite(factor) && factor > 0;
}

export function deriveRecipePrice(input: {
  perBase: number | null;
  perBaseUom: string | null;
  itemMeasure: Measure;
  ingredientMeasure: Measure;
}): {
  per: number;
  uom: "LB" | "FLOZ" | "GAL";
  qty: number;
  measureUom: string;
  from: "item" | "ingredient";
} | null {
  const { perBase, perBaseUom, itemMeasure, ingredientMeasure } = input;

  if (perBaseUom !== "EA") return null;
  if (perBase == null || !Number.isFinite(perBase) || perBase <= 0) return null;

  // Item wins when valid. The two measures may be in different
  // dimensions; the winner decides whether the display is per lb, per
  // fl oz or per gal.
  const chosen = validMeasure(itemMeasure)
    ? { m: itemMeasure, from: "item" as const }
    : validMeasure(ingredientMeasure)
      ? { m: ingredientMeasure, from: "ingredient" as const }
      : null;
  if (!chosen) return null;

  const { m, from } = chosen;
  const uomU = m.uom.toUpperCase();
  const dim = DIM_BY_UOM[uomU];
  if (dim !== "weight" && dim !== "volume") return null; // defensive; validMeasure already gates

  // Per-base-of-dimension first: $ / LB for weight, $ / FLOZ for volume.
  // qty * TO_BASE[uom] is the measure's size in the dimension's base.
  const measureInBase = m.qty * TO_BASE[uomU];
  if (!Number.isFinite(measureInBase) || measureInBase <= 0) return null;
  const perDimBase = perBase / measureInBase;

  if (dim === "weight") {
    return { per: perDimBase, uom: "LB", qty: m.qty, measureUom: uomU, from };
  }

  // Volume: show per GAL when the typed uom is one of GAL / QT / L.
  // Everything else (FLOZ, PT, ML) stays per FLOZ. This keeps small
  // numbers from collapsing to $0.00 and large numbers from blowing up
  // (a $9 wine over 750 mL is $0.35/fl oz, not $45/gal).
  if (uomU === "GAL" || uomU === "QT" || uomU === "L") {
    const perGal = convertPer(perDimBase, "FLOZ", "GAL");
    if (perGal == null || !Number.isFinite(perGal) || perGal <= 0) {
      return { per: perDimBase, uom: "FLOZ", qty: m.qty, measureUom: uomU, from };
    }
    return { per: perGal, uom: "GAL", qty: m.qty, measureUom: uomU, from };
  }
  return { per: perDimBase, uom: "FLOZ", qty: m.qty, measureUom: uomU, from };
}
