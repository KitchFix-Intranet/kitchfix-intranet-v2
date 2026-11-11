"use client";

// Panel attention block: deriveAttention computes a list of issues
// from the item + ingredient state; AttentionSection renders them
// with a Fix the pack button.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, Info } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { DIM_BY_UOM } from "@/lib/ingredients/pack";
import { ingredientBaseUom, ingredientBaseDim } from "./packHelpers";

type AttentionIssue =
  | { kind: "no_price"; tone: "bad"; head: string; body: string; fix?: "pack" }
  | { kind: "pack_unreadable"; tone: "info"; head: string; body: string; fix: "pack" }
  | { kind: "unit_mismatch"; tone: "bad"; head: string; body: string; fix: "pack"; targetUom: string }
  | { kind: "pack_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "price_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "no_ingredient"; tone: "info"; head: string; body: string };

// N6 A1: the three hand maps UOM_BASE_DIM, INGREDIENT_BASE_DIM and
// INGREDIENT_BASE_UOM are deleted. Every call site below resolves
// dimension and base uom through the shared helpers ingredientBaseDim
// + ingredientBaseUom (which in turn call canonicalFromBaseUnit ->
// DIM_BY_UOM -> BASE_BY_DIM). item.perBaseUom goes through DIM_BY_UOM
// directly. deriveAttention's issue kinds, tones, copy and order are
// unchanged - only the lookup moved.

function deriveAttention(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null
): AttentionIssue[] {
  const issues: AttentionIssue[] = [];

  // Pack provenance notes - stated as warn, not errors.
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

  // Unit mismatch (item side only - see spec acceptance 5): we only
  // claim this when the ingredient has a known base dimension AND the
  // item's own uom resolves to a different one.
  const ingBase = ingredientBaseDim(ingredient);
  const itemBase = item.perBaseUom ? (DIM_BY_UOM[item.perBaseUom] ?? null) : null;
  if (ingBase && itemBase && itemBase !== ingBase && ingredient) {
    const targetUom = ingredientBaseUom(ingredient) ?? "EA";
    issues.push({
      kind: "unit_mismatch",
      tone: "bad",
      head: `Priced in ${itemBase}, ingredient is ${ingBase}`,
      body: `${ingredient.name} is costed per ${ingredient.base_unit}. This item will not blend until the pack is corrected to match.`,
      fix: "pack",
      targetUom,
    });
  }

  // Could-not-read: show the parser's note. Only emit when it has
  // something to say, otherwise no_price covers it.
  if (item.perBase == null && item.perBaseNote) {
    issues.push({
      kind: "pack_unreadable",
      tone: "info",
      head: "Pack could not be read",
      body: item.perBaseNote,
      fix: "pack",
    });
  }

  // No price at all: the primary failure. Always paired with pack_unreadable
  // when the parser left a note; still worth stating plainly.
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

// Default UOM for the "Fix the pack" button when the issue itself
// does not pin one: the linked ingredient's base unit beats LB,
// because that is the dimension the panel is trying to join.
function fixPackDefaultUom(ingredient: ReviewCardIngredient | null): string {
  if (!ingredient) return "LB";
  // N6 A1: shared helper replaces the hand map. An ingredient costed
  // per oz now returns LB (its dimension's base), per qt returns FLOZ.
  return ingredientBaseUom(ingredient) ?? "LB";
}

function AttentionIcon({ tone }: { tone: "bad" | "warn" | "info" | "good" }) {
  if (tone === "good") return <Check size={16} strokeWidth={1.75} aria-hidden />;
  if (tone === "info") return <Info size={16} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />;
}

export function AttentionSection({
  item,
  ingredient,
  onFixPack,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onFixPack: (uom: string) => void;
}) {
  const issues = deriveAttention(item, ingredient);
  const clear = issues.length === 0;
  // Open unless the only state is "clear" (collapsed by design) and
  // unless the only issues are provenance warnings (they are not
  // actionable; let Kevin expand if curious). But if ANY real issue
  // exists, open on load.
  const hasBad = issues.some((i) => i.tone === "bad");
  const hasInfo = issues.some((i) => i.tone === "info" && i.kind !== "no_ingredient");
  const defaultOpen = hasBad || hasInfo;
  const [open, setOpen] = useState<boolean>(defaultOpen);

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="What needs attention">
      <button
        type="button"
        className="kf-attn__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={`kf-attn__chev${open ? " is-open" : ""}`}
        />
        <h4 className="kf-attn__title">What needs attention</h4>
        <span className="kf-attn__count">{clear ? "clear" : `${issues.length}`}</span>
      </button>
      {open ? (
        <div className="kf-attn__body">
          {clear ? (
            <div className="kf-attn__note kf-attn__note--good">
              <AttentionIcon tone="good" />
              <div>
                <b>Nothing flagged</b>
                <span>This item has a price in the master&rsquo;s unit, with no override on either the pack or the number.</span>
              </div>
            </div>
          ) : (() => {
            // S2: multiple issues can resolve to the same "Fix the pack"
            // action - render the button once, on the most severe one.
            // Priority: bad > info > warn (bad is the one Kevin
            // actually acts on; info/warn stay as context).
            const toneRank: Record<string, number> = { bad: 3, info: 2, warn: 1 };
            const fixCandidates = issues.filter((i) => "fix" in i && i.fix === "pack");
            fixCandidates.sort((a, b) => (toneRank[b.tone] ?? 0) - (toneRank[a.tone] ?? 0));
            const buttonKind = fixCandidates[0]?.kind ?? null;
            return issues.map((issue) => (
              <div key={issue.kind} className={`kf-attn__note kf-attn__note--${issue.tone}`}>
                <AttentionIcon tone={issue.tone} />
                <div>
                  <b>{issue.head}</b>
                  <span>{issue.body}</span>
                  {issue.kind === buttonKind ? (
                    <button
                      type="button"
                      className="kf-btn kf-btn--line kf-btn--sm kf-attn__fix"
                      onClick={() =>
                        onFixPack(
                          "targetUom" in issue
                            ? (issue as { targetUom: string }).targetUom
                            : fixPackDefaultUom(ingredient)
                        )
                      }
                    >
                      Fix the pack
                    </button>
                  ) : null}
                </div>
              </div>
            ));
          })()}
        </div>
      ) : null}
    </section>
  );
}
