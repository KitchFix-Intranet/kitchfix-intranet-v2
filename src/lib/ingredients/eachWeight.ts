// Derived per-lb for each-priced vendor items. Pure, no imports, safe to
// call from both server lib and client components (same RSC-boundary
// shape as categories.ts).
//
// Rule - not negotiable:
//   1. Derived at display, never stored. price_estimate.per_base stays
//      the price paid per each; this helper only produces the figure
//      beside it.
//   2. No weight means no per lb. Returns null without inventing one.
//   3. Only each-priced items convert. perBaseUom !== "EA" returns null;
//      lb-priced, fl-oz-priced and gal-priced items keep rendering
//      exactly as they do today.
//
// Weight precedence: an item's own each_weight_lb beats the ingredient's
// avg_weight_lb (a 6-count case holds bigger heads than a 12-count).
// Either source works on its own; neither means null.

export function derivePerLb(input: {
  perBase: number | null;
  perBaseUom: string | null;
  itemEachWeightLb: number | null;
  ingredientAvgWeightLb: number | null;
}): { perLb: number; weightLb: number; from: "item" | "ingredient" } | null {
  const { perBase, perBaseUom, itemEachWeightLb, ingredientAvgWeightLb } = input;

  if (perBaseUom !== "EA") return null;
  if (perBase == null || !Number.isFinite(perBase) || perBase <= 0) return null;

  const itemOk =
    itemEachWeightLb != null &&
    Number.isFinite(itemEachWeightLb) &&
    itemEachWeightLb > 0;
  const ingOk =
    ingredientAvgWeightLb != null &&
    Number.isFinite(ingredientAvgWeightLb) &&
    ingredientAvgWeightLb > 0;

  if (itemOk) {
    const weightLb = itemEachWeightLb as number;
    return { perLb: perBase / weightLb, weightLb, from: "item" };
  }
  if (ingOk) {
    const weightLb = ingredientAvgWeightLb as number;
    return { perLb: perBase / weightLb, weightLb, from: "ingredient" };
  }
  return null;
}
