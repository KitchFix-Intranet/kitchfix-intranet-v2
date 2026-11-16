"use client";

// N8 §3b, as of T8: four-cell summary strip. One label + one value per
// cell; the four sub-lines are gone. The strip is pinned by its
// wrapper (.kf-ipanel__pin, in DetailPanel) so Kevin can read these
// four facts from the bottom of a long panel. The four values come
// from one helper (itemFacts) so this strip and anything else that
// shows them (today: nothing; tomorrow: a future reader can import
// the same helper) stay in agreement.
//
// Sub-line facts moved out and did not disappear:
//   - Unit price's confidence word + stored per-base   -> PanelItemZone
//                                                         Pack and price row
//   - Pack's "billed by the X" + Review pill           -> already on screen
//                                                         (row + head pill)
//   - Annual spend's invoice-line count                -> PanelItemZone
//                                                         Bought row
//   - Last bought's first-bought + site pills          -> PanelItemZone
//                                                         Bought row

import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { itemFacts } from "./itemFacts";

export function PanelStrip({
  item,
  ingredient,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
}) {
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
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Pack</span>
        <span className="kf-ipanel__strip-value">{facts.pack}</span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Annual spend</span>
        <span className="kf-ipanel__strip-value">{facts.annualSpend}</span>
      </div>

      <div className="kf-ipanel__strip-cell">
        <span className="kf-ipanel__strip-label">Last bought</span>
        <span className="kf-ipanel__strip-value">
          {facts.lastBought ? facts.lastBought : <span className="kf-ipanel__strip-value-unit">-</span>}
        </span>
      </div>
    </div>
  );
}
