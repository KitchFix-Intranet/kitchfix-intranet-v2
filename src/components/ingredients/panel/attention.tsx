"use client";

// deriveAttention + AttentionIssue type. The attention surface itself
// is rendered by PanelAttention (N7 §3c). AttentionIcon lives inline in
// that component. The old AttentionSection + fixPackDefaultUom are
// gone - PanelAttention owns the icon pick + the fix-button fallback.

import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { DIM_BY_UOM } from "@/lib/ingredients/pack";
import { ingredientBaseUom, ingredientBaseDim } from "./packHelpers";

export type AttentionIssue =
  | { kind: "no_price"; tone: "bad"; head: string; body: string; fix?: "pack" }
  | { kind: "pack_unreadable"; tone: "info"; head: string; body: string; fix: "pack" }
  | { kind: "unit_mismatch"; tone: "bad"; head: string; body: string; fix: "pack"; targetUom: string }
  | { kind: "pack_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "price_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "no_ingredient"; tone: "info"; head: string; body: string };

export function deriveAttention(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null
): AttentionIssue[] {
  const issues: AttentionIssue[] = [];

  if (item.packManualOverride) {
    issues.push({
      kind: "pack_hand_set",
      tone: "warn",
      head: "Pack is set by hand",
      body: "The qty / size / UOM on this item came from a human override. The backfill will not touch it.",
    });
  }
  if (item.priceManualOverride) {
    issues.push({
      kind: "price_hand_set",
      tone: "warn",
      head: "Price is set by hand",
      body: "The $ / unit on this item came from a human override and persists across backfills.",
    });
  }

  if (!ingredient) {
    issues.push({
      kind: "no_ingredient",
      tone: "info",
      head: "Not linked to an ingredient",
      body: "This item has not been confirmed into an ingredient. The Review queue is the usual path for that.",
    });
  }

  const ingBase = ingredientBaseDim(ingredient);
  const itemBase = item.perBaseUom ? (DIM_BY_UOM[item.perBaseUom] ?? null) : null;
  if (ingBase && itemBase && itemBase !== ingBase && ingredient) {
    const targetUom = ingredientBaseUom(ingredient) ?? "EA";
    // N8 §1h: head reads like a sentence.
    const itemPhrase =
      itemBase === "weight" ? "by weight"
      : itemBase === "volume" ? "by volume"
      : "by count";
    const ingPhrase =
      ingBase === "weight" ? "weighed"
      : ingBase === "volume" ? "measured by volume"
      : "counted";
    issues.push({
      kind: "unit_mismatch",
      tone: "bad",
      head: `Priced ${itemPhrase}, ingredient is ${ingPhrase}`,
      body: `${ingredient.name} has no measure that reaches ${ingredient.base_unit}. Add a measure on the ingredient and this item will price.`,
      fix: "pack",
      targetUom,
    });
  }

  if (item.perBase == null && item.perBaseNote) {
    issues.push({
      kind: "pack_unreadable",
      tone: "info",
      head: "Pack could not be read",
      body: item.perBaseNote,
      fix: "pack",
    });
  }

  if (item.perBase == null) {
    issues.push({
      kind: "no_price",
      tone: "bad",
      head: "No per-unit price yet",
      body: "This item carries 12-month spend but no $ / unit, so every recipe cost that depends on it is wrong by this item's share.",
      fix: "pack",
    });
  }

  return issues;
}
