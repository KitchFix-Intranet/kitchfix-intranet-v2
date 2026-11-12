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

function AttentionIcon({ tone }: { tone: "bad" | "info" | "warn" }) {
  if (tone === "info") return <Info size={22} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />;
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
  const rendered = issues.filter(
    (i) =>
      i.kind === "no_price" ||
      i.kind === "pack_unreadable" ||
      i.kind === "unit_mismatch"
  );
  // N13 R4: "{n} of {lines} invoice lines were flagged when read"
  // is a warn attention line whenever needsReviewLines > 0. It lives
  // alongside the derived attention set so the user sees it in the
  // same primitive. Only fires on item panels (the ingredient
  // branch early-returns above).
  const flaggedLines =
    item?.needsReviewLines && item.needsReviewLines > 0
      ? {
          head: `${item.needsReviewLines} of ${item.lines12m} invoice lines were flagged when read`,
          body: "Reviewers queue these lines for a second look. Clearing them removes the warn here.",
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
            <span className="kf-ipanel__attn-item-body">{flaggedLines.body}</span>
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
