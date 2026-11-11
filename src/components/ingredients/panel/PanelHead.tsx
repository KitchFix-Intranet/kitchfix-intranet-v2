"use client";

// N7 §3a: the panel head. Eyebrow + display name + invoice sub-line +
// status line (`Linked to {ingredient name}` or `Not linked yet`, then
// one status pill: `N things need attention` or `All clear`). The
// ingredient's category / sub / Retail pills have LEFT the head - they
// live in the ingredient zone's header.

import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";

export function PanelHead({
  labelId,
  kind,
  item,
  ingredient,
  proposedName,
  attentionCount,
}: {
  labelId: string;
  kind: "item" | "ingredient";
  item: ReviewGroupItem | null;
  ingredient: ReviewCardIngredient | null;
  proposedName?: string | null;
  // count of §3c attention rows (bad + info, excluding provenance and
  // no_ingredient). Zero -> the head shows "All clear".
  attentionCount: number;
}) {
  const eyebrow = kind === "item" && item
    ? `Vendor item · ${item.vendor}${item.itemNumber ? ` · #${item.itemNumber}` : ""}`
    : "Ingredient";
  const name = kind === "item" && item
    ? item.displayName
    : ingredient
      ? ingredient.name
      : proposedName ?? "New ingredient";
  const showInvoice =
    kind === "item" &&
    item &&
    item.displayNameSource === "catalog" &&
    item.vendorOcrName !== item.displayName;
  const linkedTo = kind === "item"
    ? ingredient
      ? `Linked to ${ingredient.name}`
      : "Not linked yet"
    : null;

  return (
    <div className="kf-drawer__head">
      <span className="kf-eyebrow kf-eyebrow--plain">{eyebrow}</span>
      <h3 id={labelId} className="kf-drawer__name">{name}</h3>
      {showInvoice ? (
        <div className="kf-dpn__ocr" title="Vendor's invoice description (verbatim)">
          Invoice reads <span>&ldquo;{item.vendorOcrName}&rdquo;</span>
        </div>
      ) : null}
      {kind === "item" ? (
        <div className="kf-drawer__chips">
          {linkedTo ? <span className="kf-pill kf-pill--muted">{linkedTo}</span> : null}
          {attentionCount > 0 ? (
            <span className="kf-pill kf-pill--warn">
              {attentionCount} thing{attentionCount === 1 ? "" : "s"} need attention
            </span>
          ) : (
            <span className="kf-pill kf-pill--good">All clear</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
