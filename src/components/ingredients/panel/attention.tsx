"use client";

// M2 §4B §2.8: attention surface. deriveAttention produces typed
// AttentionIssue[]; PanelAttention renders them.
//
// Three M2 kinds replace / augment the old unit_mismatch:
//   needs_measure   - item can't reach ingredient's base_unit; the
//                     pack is fine, the ingredient needs a measure.
//                     Button: "Add a measure" (no "Fix the pack").
//   check_it_outlier - item is priced but ±3× median; left out of
//                     the blend. Warn tone; no action button.
//   sizes_differ    - count-costed ingredient whose sized packs
//                     disagree. Buttons: "Add a measure" (prefill
//                     1 EA = largest-spend size) + "Change Costed per".

import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { DIM_BY_UOM, canonicalFromBaseUnit, uomLabel } from "@/lib/ingredients/pack";
import { factor } from "@/lib/ingredients/measures";
import { fmtUsd } from "@/lib/fmt";

export type AttentionIssue =
  | { kind: "no_price"; tone: "bad"; head: string; body: string; fix?: "pack" }
  | { kind: "pack_unreadable"; tone: "info"; head: string; body: string; fix: "pack" }
  | {
      kind: "needs_measure";
      tone: "bad";
      head: string;
      body: string;
      action: "add_measure";
      targetUom: string;
    }
  | {
      kind: "check_it_outlier";
      tone: "warn";
      head: string;
      body: string;
    }
  | {
      kind: "sizes_differ";
      tone: "warn";
      head: string;
      body: string;
      action: "sizes_differ";
      // Prefill for the "Add a measure" button: 1 EA = {qty} {uom}
      prefillQty: number;
      prefillUom: string;
    }
  | { kind: "pack_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "price_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "no_ingredient"; tone: "info"; head: string; body: string };

// Low-case plain phrasing for the unit list: "{8 fl oz} and {14 fl oz}".
function joinSizes(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return labels.slice(0, -1).join(", ") + ", and " + labels[labels.length - 1];
}

// M2 §4B part 3 fix 4+5: DetailPanel passes the sibling-item pack
// shapes down so attention can build the sizes_differ banner body
// from the same linked-item data the Measures block uses for
// suggestions. `item.statusKind` is the source of truth for whether
// to fire; this list only supplies the piece-size facts.
export type SiblingPack = {
  id: string;
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  usd12m?: number;
};

export function deriveAttention(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null,
  siblingPacks: readonly SiblingPack[] = [],
  // Polish fix 4: the blend value drives the outlier head sentence
  // ("$X / lb is N.N times the <Ingredient> blend ($Y)"). DetailPanel
  // computes it from sibling items with statusKind="in_blend" and a
  // perBaseInIngUnit. Null when the panel cannot supply one; the head
  // falls back to the relative word without a dollar figure.
  blendPerBase: number | null = null,
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

  // T3 §3a: needs_measure fires when `item.statusKind` from
  // computeIngredientBlend (M2.1's single source) says so. The old
  // code re-ran priceInUnit here with `item.packQty / packSize`,
  // which /api/review/item never sets on the item payload - so the
  // reach test always failed and the banner stuck on "Needs a
  // measure" even after a case weight save moved the item into the
  // blend. Trust the server's statusKind, same signal the list row
  // and the strip already read. The copy and action payload stay
  // the same.
  if (
    ingredient &&
    item.perBase != null &&
    item.perBaseUom &&
    (item as { statusKind?: string }).statusKind === "needs_measure"
  ) {
    const target = canonicalFromBaseUnit(ingredient.base_unit);
    if (target) {
      // Polish fix 2: the body says HOW the case is priced, not
      // what unit it names. Three phrasings, keyed off the pack
      // dim; "by the each" (count), "by weight", "by volume".
      const packDim = DIM_BY_UOM[(item.packUom ?? "").toUpperCase()] ?? null;
      const countedBy =
        packDim === "weight"
          ? "This case is counted by weight"
          : packDim === "volume"
            ? "This case is counted by volume"
            : "This case is counted by the each";
      issues.push({
        kind: "needs_measure",
        tone: "bad",
        head: `${ingredient.name} has no measure that reaches ${ingredient.base_unit}`,
        body: `${countedBy}. Add one measure on the ingredient and this item will price.`,
        action: "add_measure",
        targetUom: target,
      });
    }
  }

  // M2 §4B §2.8: sizes_differ fires for a count-costed ingredient
  // whose sized packs disagree within one kind. Priced, shown, not
  // in any lens. Requires the ingredient to carry its full linked-
  // item pack shapes - threaded via an optional field on the item
  // when the queue/master builder populates it; otherwise skipped
  // (the Ingredients tab panel gets it from MasterRow).
  // M2 §4B part 3 fix 5: trust the server-computed statusKind rather
  // than re-running sizesDifferFlags in the client. The siblingPacks
  // list supplies the piece sizes for the banner body.
  if (ingredient && (item as { statusKind?: string }).statusKind === "sizes_differ") {
    const packs = siblingPacks;
    const measures = (ingredient.measures ?? []) as Array<{
      from_unit: string;
      qty: number;
      to_unit: string;
      source: "house_test" | "book" | "vendor_spec" | "estimate" | "pack";
    }>;
    {
      // Build the size list from the same partition rule as
      // sizesDifferFlags. Only candidates that STILL state count
      // (factor EA -> packUom is null) show up.
      const sizesByKind: Record<"weight" | "volume", Array<{ ps: number; uom: string; usd: number }>> = {
        weight: [],
        volume: [],
      };
      for (const p of packs) {
        const pu = (p.packUom ?? "").toUpperCase();
        const dim = DIM_BY_UOM[pu];
        const pq = Number(p.packQty ?? NaN);
        const ps = Number(p.packSize ?? NaN);
        if ((dim !== "weight" && dim !== "volume") || !(pq > 1) || !(ps > 0)) continue;
        if (factor("EA", pu, { measures }) != null) continue;
        sizesByKind[dim].push({ ps, uom: pu, usd: Number(p.usd12m ?? 0) });
      }
      // Pick the kind this item belongs to.
      const itemPu = (item.packUom ?? "").toUpperCase();
      const itemDim = DIM_BY_UOM[itemPu];
      const group =
        itemDim === "weight"
          ? sizesByKind.weight
          : itemDim === "volume"
            ? sizesByKind.volume
            : null;
      const sizeLabels = group
        ? Array.from(new Set(group.map((g) => `${g.ps} ${uomLabel(g.uom)}`)))
        : [];
      const biggestSpend = group ? [...group].sort((a, b) => b.usd - a.usd)[0] : null;
      const altBase =
        itemDim === "weight" ? "lb" : itemDim === "volume" ? "gal" : "lb";
      issues.push({
        kind: "sizes_differ",
        tone: "warn",
        head: "These cases come in different sizes",
        body:
          `${ingredient.name} is costed per ${ingredient.base_unit}, but its cases hold ` +
          `${joinSizes(sizeLabels)} pieces. Say what one each is, or cost this ingredient per ${altBase}.`,
        action: "sizes_differ",
        prefillQty: biggestSpend ? biggestSpend.ps : 0,
        prefillUom: biggestSpend ? biggestSpend.uom : (itemPu || "OZ"),
      });
    }
  }

  // M2 §4B §2.8: check_it_outlier - item is priced but left out of
  // the blend. Warn tone; no action button.
  // Polish fix 4: head reads "$X / lb is N.N times the <Ingredient>
  // blend ($Y)" when the item is above median, "well under" when
  // below. The blend value is passed in; missing drops the dollar
  // figure but keeps the comparison word.
  if (
    ingredient &&
    (item as { statusKind?: string }).statusKind === "check_it" &&
    item.perBaseInIngUnit != null
  ) {
    const target = canonicalFromBaseUnit(ingredient.base_unit);
    if (target) {
      const unitLabel = uomLabel(target).toLowerCase();
      const itemStr = `${fmtUsd(item.perBaseInIngUnit)} / ${unitLabel}`;
      let relative: string;
      if (blendPerBase != null && blendPerBase > 0) {
        if (item.perBaseInIngUnit >= blendPerBase) {
          const ratio = item.perBaseInIngUnit / blendPerBase;
          relative = `${ratio.toFixed(1)} times`;
        } else {
          relative = "well under";
        }
      } else {
        // Blend unknown at this mount - keep the comparison word but
        // drop the dollar figure of the blend.
        relative = "outside";
      }
      const blendStr =
        blendPerBase != null && blendPerBase > 0
          ? ` (${fmtUsd(blendPerBase)})`
          : "";
      issues.push({
        kind: "check_it_outlier",
        tone: "warn",
        head: `${itemStr} is ${relative} the ${ingredient.name} blend${blendStr}`,
        body:
          `The math is right for what was entered, so one of the inputs does not describe the real case. ` +
          `Check the measure, or enter what this case weighs. It stays out of the blend until then.`,
      });
    }
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
