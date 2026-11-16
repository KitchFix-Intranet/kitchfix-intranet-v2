"use client";

// N8 §3b: four-cell summary strip. Facts unchanged from N7 per Kevin's
// ruling (Last bought stays; Case price lives on the Pack and price
// row). Typography matches docs/renders/ITEM_PANEL_RENDER_REFERENCE.html:
// Barlow 12px uppercase label, Barlow 28px value (navy for Unit price,
// ink elsewhere), Mulish 12px sub-line.
//
// Unit price sub-line always carries the confidence word; derived
// recipe price appends after when present. perBaseNote belongs on the
// Pack and price row at rest, not here.

import { fmtCount, fmtDate } from "@/lib/fmt";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { itemFacts } from "./itemFacts";

export function PanelStrip({
  item,
  ingredient,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
}) {
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
  // T7: the four summary values come from one helper so the sticky
  // head sub-line and this strip stay in agreement. The JSX below
  // keeps every span and every class from pre-T7 unchanged; only
  // the inputs are now derived through itemFacts().
  const facts = itemFacts(item, ingredient);

  return (
    <div className="kf-ipanel__strip" aria-label="Item summary">
      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Unit price</span>
        <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
          {facts.primaryValue != null && facts.primaryUnit != null ? (
            <>
              {facts.primaryValue}{" "}
              <span className="kf-ipanel__strip-value-unit">/ {facts.primaryUnit}</span>
            </>
          ) : (
            <span className="kf-ipanel__strip-value-unit">- / unit</span>
          )}
        </span>
        <span className="kf-ipanel__strip-sub kf-ipanel__strip-sub--accent">
          <span>{confidenceWord}</span>
          {facts.storedValue != null && facts.storedUnit != null ? (
            <>
              <span>·</span>
              <span>{facts.storedValue} / {facts.storedUnit}</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Pack</span>
        <span className="kf-ipanel__strip-value">{facts.pack}</span>
        <span className="kf-ipanel__strip-sub">
          <span>billed by the {item.billedUnit ?? "-"}</span>
          {isCheck ? (
            <span className="kf-pill kf-pill--warn">Review</span>
          ) : null}
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Annual spend</span>
        <span className="kf-ipanel__strip-value">{facts.annualSpend}</span>
        <span className="kf-ipanel__strip-sub">
          <span>{fmtCount(item.lines12m)} invoice lines</span>
        </span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Last bought</span>
        <span className="kf-ipanel__strip-value">
          {facts.lastBought ? facts.lastBought : <span className="kf-ipanel__strip-value-unit">-</span>}
        </span>
        {/* N13 R4: first-bought micro sits below the sites pills,
            quiet unless the item has ever been bought. Null on
            legacy rows (API field is optional). */}
        {item.firstSeen ? (
          <span className="kf-ipanel__strip-sub">
            <span>first bought {fmtDate(item.firstSeen)}</span>
          </span>
        ) : null}
        <span className="kf-ipanel__strip-sub">
          {item.accounts.length > 0 ? (
            <span className="kf-site-pills">
              {item.accounts.map((c) => (
                <span key={c} className="kf-site-pill">{c}</span>
              ))}
            </span>
          ) : (
            <span>no sites</span>
          )}
        </span>
      </div>
    </div>
  );
}
