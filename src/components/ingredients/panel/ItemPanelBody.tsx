"use client";

// Composes the item-specific blocks under the ingredient edit panel:
// attention, grade, pack override, price override, evidence.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useState } from "react";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { AttentionSection } from "./attention";
import { ItemGradeBlock } from "./ItemGradeBlock";
import { PackOverrideBlock } from "./PackOverrideBlock";
import { PriceOverrideBlock } from "./PriceOverrideBlock";
import { EvidenceSection } from "./EvidenceSection";
import type { PackHint } from "./packHelpers";

export function ItemPanelBody({
  item,
  ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const [packHint, setPackHint] = useState<PackHint | null>(null);
  return (
    <>
      <AttentionSection
        item={item}
        ingredient={ingredient}
        onFixPack={(uom) => setPackHint({ uom, nonce: Date.now() })}
      />
      {/* G3 fix for the G1 miss: ItemGradeBlock was defined (line
          1867) but never called in this body. The function shipped,
          the JSX line did not. Chat-Claude's "zero kf-grade in the
          DOM on a mounted ItemPanelBody" was exact. Mounting it
          here now - between Attention and PackOverride, matching
          the spec pin ("plainly a quality tier, not a price field").
      */}
      <ItemGradeBlock item={item} onDone={onDone} />
      <PackOverrideBlock item={item} ingredient={ingredient} hint={packHint} onDone={onDone} />
      <PriceOverrideBlock item={item} ingredient={ingredient} onDone={onDone} />
      <EvidenceSection item={item} />
    </>
  );
}
