// T7 + T8: one place that derives the item-panel's shared values.
// PanelStrip renders the four summary values as labelled big
// numbers; PanelItemZone's Pack and price row reads the confidence
// word from `itemConfidenceWord` so there is one source for "how
// much to trust the per-unit number". Any change to how "unit
// price" is picked or how that confidence maps to a word must
// happen in this file and nowhere else.

import { fmtDate, fmtPackNumbersInText, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { canonicalFromBaseUnit, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";

export type ItemFacts = {
  // Primary unit-price value + unit. Ingredient-unit is preferred
  // when the item reaches it through priceInUnit (perBaseInIngUnit
  // is a positive finite number and the ingredient has a canonical
  // base_unit); otherwise the stored per-base value + its uom.
  // Both null when neither is available.
  primaryValue: string | null;
  primaryUnit: string | null;
  // Stored per-base value + unit, surfaced only when the primary
  // above uses the ingredient-unit AND a stored value is present.
  // PanelStrip renders this in the unit-price cell's sub-line so
  // the reader can see both numbers. Null on the single-value path.
  storedValue: string | null;
  storedUnit: string | null;
  // "1 x 20 LB" or "-" - fmtPackNumbersInText(packNormalized ?? pack ?? "-").
  pack: string;
  // fmtUsdLong(item.usd12m). PanelStrip prints this verbatim in the
  // Annual spend cell's value row; PanelHead appends " a year"
  // because the sticky sub-line has no cell label.
  annualSpend: string;
  // fmtDate(item.lastSeen) when present, else null. PanelStrip
  // prints the date directly; PanelHead wraps with "last bought ".
  lastBought: string | null;
};

// T8 §3a: the short phrase describing how the per-unit price was
// derived. Used to live inside PanelStrip's Unit price sub-line;
// moves to PanelItemZone's Pack and price row with the sub-lines'
// deletion. Keyed off item.perBaseConfidence + presence of perBase
// / perBaseUom, same ternary chain PanelStrip once had.
export function itemConfidenceWord(item: ReviewGroupItem): string {
  if (item.perBase == null || !item.perBaseUom || !item.perBaseConfidence) {
    return "needs pack";
  }
  if (item.perBaseConfidence === "override") return "override";
  if (item.perBaseConfidence === "derived") return "from spend";
  if (item.perBaseConfidence === "high") return "per-unit (high)";
  return "est. (low)";
}

export function itemFacts(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null,
): ItemFacts {
  const perBaseUomLower = item.perBaseUom
    ? item.perBaseUom === "LB" ? "lb"
      : item.perBaseUom === "FLOZ" ? "fl oz"
      : item.perBaseUom === "EA" ? "each"
      : item.perBaseUom.toLowerCase()
    : null;
  const ingUnitLabel = ingredient ? uomLabel(canonicalFromBaseUnit(ingredient.base_unit) ?? "") : "";
  const primaryPer = item.perBaseInIngUnit ?? null;
  const showIngUnitAsPrimary =
    primaryPer != null && Number.isFinite(primaryPer) && primaryPer > 0 && Boolean(ingUnitLabel);

  let primaryValue: string | null;
  let primaryUnit: string | null;
  let storedValue: string | null = null;
  let storedUnit: string | null = null;

  if (showIngUnitAsPrimary) {
    primaryValue = fmtUsd(primaryPer as number);
    primaryUnit = ingUnitLabel;
    if (item.perBase != null && perBaseUomLower) {
      storedValue = fmtUsd(item.perBase);
      storedUnit = perBaseUomLower;
    }
  } else if (item.perBase != null && perBaseUomLower) {
    primaryValue = fmtUsd(item.perBase);
    primaryUnit = perBaseUomLower;
  } else {
    primaryValue = null;
    primaryUnit = null;
  }

  return {
    primaryValue,
    primaryUnit,
    storedValue,
    storedUnit,
    pack: fmtPackNumbersInText(item.packNormalized ?? item.pack ?? "-"),
    annualSpend: fmtUsdLong(item.usd12m),
    lastBought: item.lastSeen ? fmtDate(item.lastSeen) : null,
  };
}
