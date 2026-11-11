"use client";

// N7 §3d: THIS ITEM zone. Head + rule + micro line + four rows:
//   1. Pack and price (closed at rest; opens to PackOverrideBlock)
//   2. One each (ItemEachMeasureBlock, out of pack editor)
//   3. Grade (ItemGradeBlock, headerless)
//   4. Price override (closed at rest; opens to PriceOverrideBlock)
//
// Pack and price + Price override are closed-at-rest rows: summary
// line on the value side, Edit / Override on the action side. Click
// the action to expand in place to the existing editor (B4 keeps the
// editor internals). Cancel inside the editor also collapses.
//
// Fix the pack (from PanelAttention via DetailPanel's packHint) forces
// the Pack and price row open.

import { useEffect, useState } from "react";
import { fmtUsd } from "@/lib/fmt";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { ItemGradeBlock } from "./ItemGradeBlock";
import { PackOverrideBlock } from "./PackOverrideBlock";
import { PriceOverrideBlock } from "./PriceOverrideBlock";
import { ItemEachMeasureBlock } from "./ItemEachMeasureBlock";
import type { PackHint } from "./packHelpers";

function packSourceLabel(item: ReviewGroupItem): string | null {
  // B3: four sources surfaced at rest - plain English.
  if (item.packSource === "override") return "set by hand";
  if (item.packSource === "catalog_sibling") return "from same-vendor siblings";
  if (item.packSource === "catalog") {
    return item.matchSource === "catalog_name"
      ? "from catalog (name match)"
      : "from catalog";
  }
  if (item.packSource === "invoice") return "from invoice pack text";
  return null;
}

function reviewChipTitle(item: ReviewGroupItem): string {
  // Same wording as the pre-N7 ItemFacts chip.
  return item.matchSource === "catalog_name" && item.matchScore != null
    ? `matched to a catalog row by name (trigram similarity ${item.matchScore.toFixed(2)}); verify this pack is right`
    : "pack needs human verification";
}

function casePriceSummary(item: ReviewGroupItem): string | null {
  if (item.catalogPrice != null) {
    return `${fmtUsd(item.catalogPrice)} case (catalog)`;
  }
  if (item.unitPrice != null) {
    const unit = item.unitPriceUnit ? ` /${item.unitPriceUnit}` : "";
    return `${fmtUsd(item.unitPrice)}${unit} case (billed, latest)`;
  }
  return null;
}

export function PanelItemZone({
  item,
  ingredient,
  packHint,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  packHint: PackHint | null;
  onDone: () => void;
}) {
  const [packOpen, setPackOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);

  // Fix the pack from attention forces this row open.
  useEffect(() => {
    if (packHint) setPackOpen(true);
  }, [packHint?.nonce]);

  const pack = item.packNormalized ?? item.pack ?? "-";
  const sourceLabel = packSourceLabel(item);
  const casePrice = casePriceSummary(item);
  const isCheck = item.packState === "check";
  const chipTitle = reviewChipTitle(item);

  return (
    <section className="kf-ipanel__zone kf-ipanel__zone--item" aria-label="This item">
      <header className="kf-ipanel__zone-head">
        <h4>This item</h4>
        <span className="kf-ipanel__zone-head-right">
          How the invoice reads it, what to change it to, and the result.
        </span>
      </header>

      {/* Row 1: Pack and price. Closed-at-rest summary. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Pack and price</span>
          {sourceLabel ? (
            <span className="kf-ipanel__row-label-sub">{sourceLabel}</span>
          ) : null}
        </div>
        <div className="kf-ipanel__row-value">
          <div className="kf-ipanel__row-value-flex">
            <strong>{pack}</strong>
            <span className="kf-muted">
              {item.billedUnit ? `billed by the ${item.billedUnit}` : "-"}
            </span>
            {isCheck ? (
              <span className="kf-pill kf-pill--warn" title={chipTitle}>Review</span>
            ) : null}
          </div>
          {casePrice ? (
            <span className="kf-ipanel__row-label-sub">{casePrice}</span>
          ) : null}
          {item.packNote ? (
            <span className="kf-ipanel__row-label-sub">{item.packNote}</span>
          ) : null}
          {item.perBaseNote ? (
            <span className="kf-ipanel__row-label-sub">{item.perBaseNote}</span>
          ) : null}
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${packOpen ? " is-on" : ""}`}
            onClick={() => setPackOpen((v) => !v)}
            aria-expanded={packOpen}
          >
            {packOpen ? "Done" : "Edit"}
          </button>
        </div>
        {packOpen ? (
          <div className="kf-ipanel__row-open">
            <PackOverrideBlock
              item={item}
              ingredient={ingredient}
              hint={packHint}
              onDone={() => {
                onDone();
                setPackOpen(false);
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Row 2: One each is - EA-costed items only. */}
      {item.perBaseUom === "EA" ? (
        <div className="kf-ipanel__row">
          <div className="kf-ipanel__row-label">
            <span>One each is</span>
          </div>
          <div className="kf-ipanel__row-value">
            <ItemEachMeasureBlock item={item} ingredient={ingredient} onDone={onDone} />
          </div>
          <div className="kf-ipanel__row-action" />
        </div>
      ) : null}

      {/* Row 3: Grade. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Grade</span>
          <span className="kf-ipanel__row-label-sub">Standard or Premium</span>
        </div>
        <div className="kf-ipanel__row-value">
          <ItemGradeBlock item={item} onDone={onDone} />
        </div>
        <div className="kf-ipanel__row-action" />
      </div>

      {/* Row 4: Price override. Closed-at-rest summary. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Price override</span>
          {item.priceManualOverride ? (
            <span className="kf-ipanel__row-label-sub">set by hand</span>
          ) : null}
        </div>
        <div className="kf-ipanel__row-value">
          {item.priceManualOverride && item.perBase != null && item.perBaseUom ? (
            <strong>
              {fmtUsd(item.perBase)}{" "}
              <span className="kf-muted">/ {item.perBaseUom.toLowerCase()}</span>
            </strong>
          ) : (
            <span className="kf-muted">no override; fixing the pack above corrects the cause</span>
          )}
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${priceOpen ? " is-on" : ""}`}
            onClick={() => setPriceOpen((v) => !v)}
            aria-expanded={priceOpen}
          >
            {priceOpen ? "Done" : "Override"}
          </button>
        </div>
        {priceOpen ? (
          <div className="kf-ipanel__row-open">
            <PriceOverrideBlock
              item={item}
              ingredient={ingredient}
              onDone={() => {
                onDone();
                setPriceOpen(false);
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
