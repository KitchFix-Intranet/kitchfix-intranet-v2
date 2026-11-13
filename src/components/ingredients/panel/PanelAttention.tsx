"use client";

// N8 §3c + §1h: Needs attention. Warn-tinted ground (bad/info variants
// override), icon left + head/body + Fix the pack button right. Not a
// red rule. deriveAttention's kinds/tones/order unchanged; only the
// mismatch head copy moved to a natural sentence (in attention.tsx).
//
// Rendered only when there is something; the head pill drives the
// count. Always open, no chevron. "Fix the pack" opens the Pack and
// price row via the parent's onFixPack(uom).

import { AlertTriangle, Info } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { deriveAttention } from "./attention";
import { ingredientBaseUom } from "./packHelpers";

export type PanelAttentionCounts = {
  total: number;
  hasNoIngredient: boolean;
  provenance: {
    packHandSet: boolean;
    priceHandSet: boolean;
  };
};

export function computeAttentionCounts(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null,
  siblingPacks: readonly import("./attention").SiblingPack[] = [],
  blendPerBase: number | null = null,
): PanelAttentionCounts {
  const issues = deriveAttention(item, ingredient, siblingPacks, blendPerBase);
  let packHandSet = false;
  let priceHandSet = false;
  let hasNoIngredient = false;
  let total = 0;
  for (const i of issues) {
    if (i.kind === "pack_hand_set") packHandSet = true;
    else if (i.kind === "price_hand_set") priceHandSet = true;
    else if (i.kind === "no_ingredient") hasNoIngredient = true;
    else total += 1;
  }
  return { total, hasNoIngredient, provenance: { packHandSet, priceHandSet } };
}

function AttentionIcon({ tone }: { tone: "bad" | "info" | "warn" }) {
  if (tone === "info") return <Info size={22} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />;
}

export function PanelAttention({
  item,
  ingredient,
  onFixPack,
  onAddMeasure,
  onChangeCostedPer,
  siblingPacks = [],
  blendPerBase = null,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onFixPack: (uom: string) => void;
  // M2 §4B part 3 fix 6: "Add a measure" callback replaces
  // document.querySelector scrolling. needs_measure passes the
  // bridge that reaches base_unit; sizes_differ passes the
  // largest-spend size qty + pack_uom.
  onAddMeasure?: (uom: string, prefillQty?: number) => void;
  onChangeCostedPer?: () => void;
  // M2 §4B part 3 fix 4: sibling items' pack shapes drive the
  // sizes_differ banner body.
  siblingPacks?: readonly import("./attention").SiblingPack[];
  // Polish fix 4: blended $/base-unit across sibling in-blend items;
  // the outlier head needs this to say "$X is N.N times the blend ($Y)".
  blendPerBase?: number | null;
}) {
  const issues = deriveAttention(item, ingredient, siblingPacks, blendPerBase);
  // M2 §4B §2.8: render no_price, pack_unreadable (both keep Fix the
  // pack) and the three M2 kinds (needs_measure, check_it_outlier,
  // sizes_differ). The old unit_mismatch kind is gone.
  const rendered = issues.filter(
    (i) =>
      i.kind === "no_price" ||
      i.kind === "pack_unreadable" ||
      i.kind === "needs_measure" ||
      i.kind === "check_it_outlier" ||
      i.kind === "sizes_differ",
  );
  // N13 R4: "{n} of {lines} invoice lines were flagged when read"
  // is a warn attention line whenever needsReviewLines > 0. One line,
  // no body - round 3 fix 3: the prior body sentence was invented;
  // nothing in the prompt or the old drawer sources it.
  const flaggedLines =
    item?.needsReviewLines && item.needsReviewLines > 0
      ? {
          head: `${item.needsReviewLines} of ${item.lines12m} invoice lines were flagged when read`,
        }
      : null;
  if (rendered.length === 0 && !flaggedLines) return null;

  const toneRank: Record<string, number> = { bad: 3, info: 2, warn: 1 };
  const fixable = rendered
    .filter((i) => "fix" in i && i.fix === "pack")
    .sort((a, b) => (toneRank[b.tone] ?? 0) - (toneRank[a.tone] ?? 0));
  const fixKind = fixable[0]?.kind ?? null;

  return (
    <div className="kf-ipanel__attn" aria-label="What needs attention">
      {flaggedLines ? (
        <div className="kf-ipanel__attn-item">
          <span className="kf-ipanel__attn-icon">
            <AttentionIcon tone="warn" />
          </span>
          <div className="kf-ipanel__attn-item-text">
            <span className="kf-ipanel__attn-item-head">{flaggedLines.head}</span>
          </div>
        </div>
      ) : null}
      {rendered.map((issue) => {
        const tone: "bad" | "info" | "warn" =
          issue.tone === "bad" ? "bad" : issue.tone === "info" ? "info" : "warn";
        return (
          <div
            key={issue.kind}
            className={`kf-ipanel__attn-item${tone === "bad" ? " kf-ipanel__attn-item--bad" : tone === "info" ? " kf-ipanel__attn-item--info" : ""}`}
          >
            <span className="kf-ipanel__attn-icon">
              <AttentionIcon tone={tone} />
            </span>
            <div className="kf-ipanel__attn-item-text">
              <span className="kf-ipanel__attn-item-head">{issue.head}</span>
              <span className="kf-ipanel__attn-item-body">{issue.body}</span>
            </div>
            {issue.kind === fixKind ? (
              <button
                type="button"
                className="kf-btn kf-btn--line kf-btn--sm"
                onClick={() => onFixPack(ingredientBaseUom(ingredient) ?? "LB")}
              >
                Fix the pack
              </button>
            ) : null}
            {/* M2 §4B §2.8: needs_measure gets "Add a measure" only
                - never "Fix the pack". Wired through the shared
                bus so the measures block's add row opens prefilled
                for the bridge that reaches base_unit. */}
            {issue.kind === "needs_measure" ? (
              <button
                type="button"
                className="kf-btn kf-btn--line kf-btn--sm"
                onClick={() => onAddMeasure?.(issue.targetUom)}
              >
                Add a measure
              </button>
            ) : null}
            {/* M2 §4B §2.8: sizes_differ gets two buttons - Add a
                measure (prefill 1 EA = largest-spend size) + Change
                Costed per (focus the BaseUnitControl). */}
            {issue.kind === "sizes_differ" ? (
              <>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => onAddMeasure?.(issue.prefillUom, issue.prefillQty)}
                >
                  Add a measure
                </button>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => onChangeCostedPer?.()}
                >
                  Change Costed per
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
