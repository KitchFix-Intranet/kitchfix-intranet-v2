"use client";

// N7 §3b: four-cell summary strip. Replaces the ItemFacts dl. Each
// cell's label + value + sub-line comes from the item. Facts are
// unchanged from ItemFacts; only the shape moves.
//
// B2: Unit price sub-line ALWAYS carries the confidence word
// (from spend / per-unit (high) / est. (low) / override / needs pack).
// When deriveRecipePrice returns a value it appears AFTER, never
// instead. perBaseNote does not go here - it goes on the Pack and
// price row at rest (handled in PanelItemZone).

import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { uomLabel } from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/eachMeasure";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";

export function PanelStrip({
  item,
  ingredient,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
}) {
  const pack = item.packNormalized ?? item.pack ?? "-";
  const isCheck = item.packState === "check";
  const confidenceWord =
    item.perBase == null || !item.perBaseUom || !item.perBaseConfidence
      ? "needs pack"
      : item.perBaseConfidence === "override"
        ? "override"
        : item.perBaseConfidence === "derived"
          ? "from spend"
          : item.perBaseConfidence === "high"
            ? "per-unit (high)"
            : "est. (low)";
  const perBaseUomLower = item.perBaseUom
    ? item.perBaseUom === "LB" ? "lb"
      : item.perBaseUom === "FLOZ" ? "fl oz"
      : item.perBaseUom === "EA" ? "each"
      : item.perBaseUom.toLowerCase()
    : null;
  const ingredientMeasure =
    ingredient?.each_measure_qty != null && ingredient?.each_measure_uom
      ? { qty: Number(ingredient.each_measure_qty), uom: ingredient.each_measure_uom }
      : null;
  const derived = deriveRecipePrice({
    perBase: item.perBase,
    perBaseUom: item.perBaseUom,
    itemMeasure: item.eachMeasure,
    ingredientMeasure,
  });

  return (
    <div className="kf-ipanel__strip" aria-label="Item summary">
      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Unit price</span>
        <span className="kf-ipanel__strip-value">
          {item.perBase != null && perBaseUomLower ? (
            <>{fmtUsd(item.perBase)} <span className="kf-muted">/ {perBaseUomLower}</span></>
          ) : (
            <span className="kf-muted">- / unit</span>
          )}
        </span>
        <span className="kf-ipanel__strip-sub">
          <span>{confidenceWord}</span>
          {derived ? (
            <>
              <span className="kf-muted">·</span>
              <strong>{fmtUsd(derived.per)} / {uomLabel(derived.uom)}</strong>
            </>
          ) : null}
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Pack</span>
        <span className="kf-ipanel__strip-value">{pack}</span>
        <span className="kf-ipanel__strip-sub">
          <span>billed by the {item.billedUnit ?? "-"}</span>
          {isCheck ? (
            <span className="kf-pill kf-pill--warn">Review</span>
          ) : null}
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Annual spend</span>
        <span className="kf-ipanel__strip-value">${fmtUsdLong(item.usd12m).replace(/^\$/, "")}</span>
        <span className="kf-ipanel__strip-sub">
          <span>{fmtCount(item.lines12m)} invoice lines</span>
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Last bought</span>
        <span className="kf-ipanel__strip-value">
          {item.lastSeen ? fmtDate(item.lastSeen) : <span className="kf-muted">-</span>}
        </span>
        <span className="kf-ipanel__strip-sub">
          {item.accounts.length > 0 ? (
            <span className="kf-site-pills">
              {item.accounts.map((c) => (
                <span key={c} className="kf-site-pill">{c}</span>
              ))}
            </span>
          ) : (
            <span className="kf-muted">no sites</span>
          )}
        </span>
      </div>
    </div>
  );
}
