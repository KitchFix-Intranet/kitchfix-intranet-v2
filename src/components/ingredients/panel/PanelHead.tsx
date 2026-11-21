"use client";

// T6 item 1: the head is the only pinned block. Red Barlow eyebrow +
// navy Barlow name (uppercase, now at --sp-t-title not the retired
// 26 px raw value), status line, step + Close.
//
// T6 ruling 9: the name heading is the panel's focus target on
// open. forwardRef now points at the h3, which carries tabIndex=-1
// so a screen reader reads what opened and the first Tab lands on
// the first real control. The Close button is reachable by Tab from
// the heading forward.
//
// Prev / Next (item mode with a list of more than one) sit alongside
// Close as icon buttons at the right of the head.

import { forwardRef } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";

export const PanelHead = forwardRef<HTMLHeadingElement, {
  labelId: string;
  kind: "item" | "ingredient";
  item: ReviewGroupItem | null;
  ingredient: ReviewCardIngredient | null;
  proposedName?: string | null;
  attentionCount: number;
  onClose: () => void;
  // T6 item 8 + ruling 4: Prev/Next within the surface's own list.
  // Null index or <= 1 list disables both.
  stepIndex?: number | null;
  stepTotal?: number | null;
  onPrev?: () => void;
  onNext?: () => void;
}>(function PanelHead(
  { labelId, kind, item, ingredient, proposedName, attentionCount, onClose, stepIndex, stepTotal, onPrev, onNext },
  nameRef,
) {
  // T6 round 2 item 7: reference's vItemPanel reads
  //   "<vendor> · item number <num>"
  // or "<vendor> · no item number"; the "Vendor item" prefix is
  // retired. The optional "N of M" counter rides at the tail.
  const eyebrow = kind === "item" && item
    ? `${item.vendor}${
        item.itemNumber
          ? ` · item number ${item.itemNumber}`
          : " · no item number"
      }${
        stepIndex != null && stepTotal != null && stepTotal > 1
          ? ` · ${stepIndex + 1} of ${stepTotal}`
          : ""
      }`
    : "Ingredient";
  const name = kind === "item" && item
    ? item.displayName
    : ingredient
      ? ingredient.name
      : proposedName ?? "New ingredient";
  const linkedName = kind === "item" && ingredient ? ingredient.name : null;
  const notLinked = kind === "item" && !ingredient;
  const attentionWord = attentionCount === 1 ? "thing needs" : "things need";

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
  const showNotFoodPill =
    kind === "item" && state === "not_food" && item?.isFood === false;

  const many = stepIndex != null && stepTotal != null && stepTotal > 1;
  const atStart = many && stepIndex === 0;
  const atEnd = many && stepTotal != null && stepIndex === stepTotal - 1;

  return (
    <div className="kf-ipanel__head">
      <div className="kf-ipanel__head-body">
        <div className="kf-ipanel__eyebrow">{eyebrow}</div>
        <h3
          id={labelId}
          className="kf-ipanel__name"
          ref={nameRef}
          tabIndex={-1}
        >
          {name}
        </h3>
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
      <div className="kf-ipanel__head-nav">
        {many ? (
          <>
            {/* T6 round 2 item 8: Previous is drawn disabled on the
                first item (not hidden) so the step buttons do not
                move under the pointer; same for Next on the last. */}
            <button
              type="button"
              className="kf-ipanel__close"
              onClick={() => onPrev?.()}
              disabled={atStart || !onPrev}
              aria-label="Previous item"
            >
              <ChevronUp size={20} strokeWidth={1.5} aria-hidden />
            </button>
            <button
              type="button"
              className="kf-ipanel__close"
              onClick={() => onNext?.()}
              disabled={atEnd || !onNext}
              aria-label="Next item"
            >
              <ChevronDown size={20} strokeWidth={1.5} aria-hidden />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="kf-ipanel__close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={20} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </div>
  );
});
