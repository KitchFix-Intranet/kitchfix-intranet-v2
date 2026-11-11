"use client";

// N7 §3c: the panel's Needs attention block. deriveAttention is NOT
// rewritten; this wrapper re-homes its issue kinds per the prompt:
//   no_price, pack_unreadable, unit_mismatch -> here
//   pack_hand_set, price_hand_set            -> provenance, not attention
//   no_ingredient                            -> ingredient zone pending
// Rendered only when there is something; the head pill drives the
// count. Always open (no chevron). "Fix the pack" opens the Pack and
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

// Shared with PanelHead so the head pill and the block agree on count.
export function computeAttentionCounts(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null
): PanelAttentionCounts {
  const issues = deriveAttention(item, ingredient);
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

function AttentionIcon({ tone }: { tone: "bad" | "info" }) {
  if (tone === "info") return <Info size={16} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />;
}

export function PanelAttention({
  item,
  ingredient,
  onFixPack,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onFixPack: (uom: string) => void;
}) {
  const issues = deriveAttention(item, ingredient);
  // Filter to the three kinds that are actually attention.
  const rendered = issues.filter(
    (i) =>
      i.kind === "no_price" ||
      i.kind === "pack_unreadable" ||
      i.kind === "unit_mismatch"
  );
  if (rendered.length === 0) return null;

  // One Fix the pack button on the most severe fixable issue, same
  // priority as the pre-N7 AttentionSection (bad > info).
  const toneRank: Record<string, number> = { bad: 3, info: 2, warn: 1 };
  const fixable = rendered
    .filter((i) => "fix" in i && i.fix === "pack")
    .sort((a, b) => (toneRank[b.tone] ?? 0) - (toneRank[a.tone] ?? 0));
  const fixKind = fixable[0]?.kind ?? null;

  return (
    <div className="kf-ipanel__attn" aria-label="What needs attention">
      {rendered.map((issue) => {
        const tone: "bad" | "info" = issue.tone === "bad" ? "bad" : "info";
        return (
          <div
            key={issue.kind}
            className={`kf-ipanel__attn-item kf-ipanel__attn-item--${tone}`}
          >
            <AttentionIcon tone={tone} />
            <div className="kf-ipanel__attn-item-text">
              <span className="kf-ipanel__attn-item-head">{issue.head}</span>
              <span className="kf-ipanel__attn-item-body">{issue.body}</span>
            </div>
            {issue.kind === fixKind ? (
              <button
                type="button"
                className="kf-btn kf-btn--line kf-btn--sm"
                onClick={() =>
                  onFixPack(
                    "targetUom" in issue
                      ? (issue as { targetUom: string }).targetUom
                      : ingredientBaseUom(ingredient) ?? "LB"
                  )
                }
              >
                Fix the pack
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
