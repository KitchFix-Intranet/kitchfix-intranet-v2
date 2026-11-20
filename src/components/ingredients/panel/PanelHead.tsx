"use client";

// N8 §3a: head. Red Barlow eyebrow + navy Barlow name (uppercase) +
// status line ("Linked to {name}" as text + attention pill). Close
// button is a 44x44 outlined square inside the head (to the right of
// the name block).
//
// T8: the sticky wrapper moved up to DetailPanel (.kf-ipanel__pin
// wraps head + strip so the four grey summary cells stay on screen).
// Head is no longer sticky itself; its opaque background +
// border-bottom stay. The T7 facts sub-line was removed as part of
// the same change - the pinned strip replaces it.

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

  // N8 round 4 fix 2: the pill tells the truth. "All clear" renders
  // ONLY when all three hold: zero attention rows, item is linked,
  // and packState !== "check". Attention rows -> count pill.
  // No ingredient -> no pill (the status line already says "Not
  // linked yet"). packState === "check" with zero attention rows
  // -> "Pack needs review" (warn). deriveAttention and the attention
  // block are not consulted or changed by this - we key off the two
  // observable facts the head carries (count + item.packState).
  const packNeedsReview = kind === "item" && item?.packState === "check";
  let pill: React.ReactNode = null;
  if (attentionCount > 0) {
    pill = (
      <span className="kf-pill kf-pill--warn">
        {attentionCount} {attentionWord} attention
      </span>
    );
  } else if (kind === "item" && ingredient && packNeedsReview) {
    pill = <span className="kf-pill kf-pill--warn">Pack needs review</span>;
  } else if (kind === "item" && ingredient) {
    pill = <span className="kf-pill kf-pill--good">All clear</span>;
  }
  // kind === "item" && !ingredient -> no pill (status line carries
  // "Not linked yet"); kind === "ingredient" -> head has no status
  // line at all, no pill.

  // T4 R2 §3: the state name comes from `item.state`, which the
  // server computed via getVendorItemState. That reads the old and
  // new shapes the same way, so an old-shape one-off (status still
  // 'archived') reads "One-off" here, matching what the list beside
  // the panel says. Nothing in this component branches on
  // `item.status` / `item.isFood` / `item.link_reason` directly.
  const state = kind === "item" ? item?.state : null;
  const statusPill =
    state === "archived"
      ? "Archived"
      : state === "one_off"
        ? "One-off"
        : state === "not_food"
          ? "Not food"
          : state === "duplicate"
            ? "Duplicate"
            : state === "retail"
              ? "Retail"
              : null;
  // Intake-flagged not-food (is_food=false) gets the plain "Not food"
  // pill too - but the state helper already returns "not_food" for
  // those rows, so the statusPill above covers it. showNotFoodPill
  // stays for the foodReason sub-line, which only has meaning when
  // intake was the classifier.
  const showNotFoodPill =
    kind === "item" && state === "not_food" && item?.isFood === false;

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
            {pill}
            {statusPill ? (
              <span className="kf-pill kf-pill--muted">{statusPill}</span>
            ) : null}
            {showNotFoodPill ? (
              <>
                <span className="kf-pill kf-pill--muted">Not food</span>
                {item?.foodReason ? (
                  <span className="kf-ipanel__status-note">{item.foodReason}</span>
                ) : null}
              </>
            ) : null}
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
