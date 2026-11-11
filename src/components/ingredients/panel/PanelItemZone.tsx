"use client";

// N8 §3d: THIS ITEM zone. Head + rule + micro line + four rows:
//   1. Pack and price   closed-at-rest summary, Edit toggle to the
//                       bordered PackOverrideBlock editor
//   2. One each is      ItemEachMeasureBlock, checkbox + optional
//                       qty/unit inline (render frame A/B)
//   3. Grade            kf-ipanel__seg segmented control
//   4. Price override   closed-at-rest "None. Use only when ..."
//                       with Override toggle to PriceOverrideBlock
//
// At-rest summary of Pack and price is one line per the render:
//   {qty} x {size} {uom} [= {total} {lower}] · {casePrice} case
//   ({sourcePhrase}) · {perUnit} / {baseUom}
// When the pack cannot be read, the whole row says so plainly and the
// price part is omitted. Provenance (set by hand / from catalog / ...)
// goes on the row's muted micro sub-line beneath the summary.

import { useEffect, useState } from "react";
import { fmtUsd } from "@/lib/fmt";
import { DIM_BY_UOM } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { ItemGradeBlock } from "./ItemGradeBlock";
import { PackOverrideBlock } from "./PackOverrideBlock";
import { PriceOverrideBlock } from "./PriceOverrideBlock";
import { ItemEachMeasureBlock } from "./ItemEachMeasureBlock";
import { parsePackNormalized, type PackHint } from "./packHelpers";

// Plain-English pack provenance. One phrase per source. §1b: this is
// the muted micro line under the summary, not the label column.
function packSourceLabel(item: ReviewGroupItem): string | null {
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
  return item.matchSource === "catalog_name" && item.matchScore != null
    ? `matched to a catalog row by name (trigram similarity ${item.matchScore.toFixed(2)}); verify this pack is right`
    : "pack needs human verification";
}

// Lowercase display of a stored UOM (LB → lb, FLOZ → fl oz, EA → each).
function uomDisplayLower(u: string | null | undefined): string {
  if (!u) return "unit";
  const U = u.toUpperCase();
  if (U === "LB") return "lb";
  if (U === "FLOZ") return "fl oz";
  if (U === "EA") return "each";
  return u.toLowerCase();
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

  useEffect(() => {
    if (packHint) setPackOpen(true);
  }, [packHint?.nonce]);

  const parsed = parsePackNormalized(item.packNormalized ?? item.pack ?? null);
  const isCheck = item.packState === "check";
  const sourceLabel = packSourceLabel(item);
  const chipTitle = reviewChipTitle(item);

  // Pack segment: "{qty} x {size} {uom}" with " = {total} {unit}" when
  // weight/volume dim makes the math meaningful.
  function packSegment(): string | null {
    if (!parsed) return null;
    const { qty, size, uom } = parsed;
    const base = `${qty} x ${size} ${uom}`;
    const dim = DIM_BY_UOM[uom] ?? null;
    if (dim === "weight" || dim === "volume") {
      const total = qty * size;
      const totalRounded = Number.isInteger(total) ? String(total) : total.toFixed(2);
      return `${base} = ${totalRounded} ${uomDisplayLower(uom)}`;
    }
    return base;
  }

  // "$X case (source)" - no doubled unit, ever.
  function casePriceSegment(): string | null {
    if (item.catalogPrice != null && item.catalogPrice > 0) {
      return `${fmtUsd(item.catalogPrice)} case (catalog)`;
    }
    if (item.unitPrice != null && item.unitPrice > 0) {
      return `${fmtUsd(item.unitPrice)} case (billed, latest)`;
    }
    return null;
  }

  const packSeg = packSegment();
  const caseSeg = casePriceSegment();
  const perUnitSeg =
    item.perBase != null && item.perBaseUom
      ? `${fmtUsd(item.perBase)} / ${uomDisplayLower(item.perBaseUom)}`
      : null;

  return (
    <section className="kf-ipanel__zone kf-ipanel__zone--item" aria-label="This item">
      <header className="kf-ipanel__zone-head">
        <span className="kf-ipanel__zone-head-title">This item</span>
        <span className="kf-ipanel__zone-head-sub">Changes here touch this vendor item only</span>
      </header>

      {/* Row 1: Pack and price ------------------------------------ */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">Pack and price</div>
        <div className="kf-ipanel__row-value">
          <div className="kf-ipanel__pack-summary">
            {packSeg ? (
              <>
                {/* N8 round 3 fix 6: each segment is nowrap; wraps
                    only happen BETWEEN them. Pack + Review chip stay
                    together so the chip never trails the price. "·"
                    sits at the START of case + per-unit segments so
                    no dot dangles at a line end. */}
                <span className="kf-ipanel__pack-seg">
                  {packSeg}
                  {isCheck ? (
                    <>
                      {" "}
                      <span className="kf-pill kf-pill--warn" title={chipTitle}>Review</span>
                    </>
                  ) : null}
                </span>
                {caseSeg ? (
                  <>
                    {" "}
                    <span className="kf-ipanel__pack-seg">&middot; {caseSeg}</span>
                  </>
                ) : null}
                {perUnitSeg ? (
                  <>
                    {" "}
                    <span className="kf-ipanel__pack-seg"><strong>&middot; {perUnitSeg}</strong></span>
                  </>
                ) : null}
              </>
            ) : (
              <>Pack could not be read.</>
            )}
          </div>
          {sourceLabel ? (
            <div className="kf-ipanel__row-hint">{sourceLabel}</div>
          ) : null}
          {item.packNote ? (
            <div className="kf-ipanel__row-hint">{item.packNote}</div>
          ) : null}
          {item.perBaseNote && !parsed ? (
            <div className="kf-ipanel__row-hint">{item.perBaseNote}</div>
          ) : null}
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className="kf-ipanel__row-toggle"
            onClick={() => setPackOpen((v) => !v)}
            aria-expanded={packOpen}
          >
            {packOpen ? "Close" : "Edit"}
          </button>
        </div>
        {packOpen ? (
          <div className="kf-ipanel__row-open">
            <PackOverrideBlock
              item={item}
              ingredient={ingredient}
              hint={packHint}
              onDone={() => { onDone(); setPackOpen(false); }}
              onCancel={() => setPackOpen(false)}
            />
          </div>
        ) : null}
      </div>

      {/* Row 2: One each is - item-side override ----------------- */}
      {item.perBaseUom === "EA" ? (
        <div className="kf-ipanel__row">
          <div className="kf-ipanel__row-label">One each is</div>
          <div className="kf-ipanel__row-value">
            <ItemEachMeasureBlock item={item} ingredient={ingredient} onDone={onDone} />
          </div>
          <div className="kf-ipanel__row-action" />
        </div>
      ) : null}

      {/* Row 3: Grade -------------------------------------------- */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">Grade</div>
        <div className="kf-ipanel__row-value">
          <ItemGradeBlock item={item} onDone={onDone} />
        </div>
        <div className="kf-ipanel__row-action" />
      </div>

      {/* Row 4: Price override ---------------------------------- */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">Price override</div>
        <div className="kf-ipanel__row-value">
          {item.priceManualOverride && item.perBase != null && item.perBaseUom ? (
            <div className="kf-ipanel__pack-summary">
              <strong>{fmtUsd(item.perBase)}</strong>{" "}
              / {uomDisplayLower(item.perBaseUom)}{" "}
              <span className="kf-ipanel__row-hint" style={{ display: "inline" }}>- set by hand</span>
            </div>
          ) : (
            <div className="kf-ipanel__pack-summary">
              None. Use only when the pack is right and the number is not.
            </div>
          )}
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className="kf-ipanel__row-toggle"
            onClick={() => setPriceOpen((v) => !v)}
            aria-expanded={priceOpen}
          >
            {priceOpen ? "Close" : "Override"}
          </button>
        </div>
        {priceOpen ? (
          <div className="kf-ipanel__row-open">
            <PriceOverrideBlock
              item={item}
              ingredient={ingredient}
              onDone={() => { onDone(); setPriceOpen(false); }}
              onCancel={() => setPriceOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
