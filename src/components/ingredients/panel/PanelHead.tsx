"use client";

// N8 §3a: head. Red Barlow eyebrow + navy Barlow name (uppercase) +
// status line ("Linked to {name}" as text + attention pill). Close
// button is a 44x44 outlined square inside the head (to the right of
// the name block). Sticky-opaque so the summary strip is never
// clipped at scroll 0.

import { forwardRef } from "react";
import { X } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";

export const PanelHead = forwardRef<HTMLButtonElement, {
  labelId: string;
  kind: "item" | "ingredient";
  item: ReviewGroupItem | null;
  ingredient: ReviewCardIngredient | null;
  proposedName?: string | null;
  attentionCount: number;
  onClose: () => void;
}>(function PanelHead(
  { labelId, kind, item, ingredient, proposedName, attentionCount, onClose },
  closeRef,
) {
  const eyebrow = kind === "item" && item
    ? `Vendor item · ${item.vendor}${item.itemNumber ? ` · #${item.itemNumber}` : ""}`
    : "Ingredient";
  const name = kind === "item" && item
    ? item.displayName
    : ingredient
      ? ingredient.name
      : proposedName ?? "New ingredient";
  const linkedName = kind === "item" && ingredient ? ingredient.name : null;
  const notLinked = kind === "item" && !ingredient;
  // §1c: "1 thing needs attention" / "2 things need attention".
  const attentionWord = attentionCount === 1 ? "thing needs" : "things need";

  return (
    <div className="kf-ipanel__head">
      <div className="kf-ipanel__head-body">
        <div className="kf-ipanel__eyebrow">{eyebrow}</div>
        <h3 id={labelId} className="kf-ipanel__name">{name}</h3>
        {kind === "item" ? (
          <div className="kf-ipanel__status">
            {linkedName ? (
              <>
                <span>Linked to</span>
                <span className="kf-ipanel__status-name">{linkedName}</span>
              </>
            ) : notLinked ? (
              <span>Not linked yet</span>
            ) : null}
            {attentionCount > 0 ? (
              <span className="kf-pill kf-pill--warn">
                {attentionCount} {attentionWord} attention
              </span>
            ) : (
              <span className="kf-pill kf-pill--good">All clear</span>
            )}
          </div>
        ) : null}
      </div>
      <button
        ref={closeRef}
        type="button"
        className="kf-ipanel__close"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={20} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
});
