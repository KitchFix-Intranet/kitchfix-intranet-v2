"use client";

// M2 §4B §2.6: "Recipes can use" chips in the ingredient zone.
// Solid chip: a unit the ingredient's items can price in (reaches
// through the measures graph). Dashed chip: a unit a linked item
// would need a bridge for; clicking it signals the measures block
// to open the add row prefilled for that uom.

import type { Measure } from "@/lib/ingredients/measures";
import { factor } from "@/lib/ingredients/measures";
import { uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient } from "../itemTypes";

const CORE_UNITS = ["LB", "OZ", "EA", "FLOZ", "GAL"] as const;

export function PanelChipsRow({
  ingredient,
  measures,
  itemUnits = [],
  onAddForUom,
}: {
  ingredient: ReviewCardIngredient;
  measures: readonly Measure[];
  // Any additional units linked items are priced in. The core five
  // always show; these extend the chip list for exotic ingredients.
  itemUnits?: readonly string[];
  onAddForUom?: (uom: string) => void;
}) {
  // Deduped list of units to show. Start from core + any exotic.
  const seen = new Set<string>();
  const list: string[] = [];
  for (const u of [...CORE_UNITS, ...itemUnits]) {
    const up = u.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    list.push(up);
  }

  const m = { measures };

  return (
    <div className="kf-ipanel__row kf-ipanel__row--chips">
      <div className="kf-ipanel__row-label">
        <span>Recipes can use</span>
      </div>
      <div className="kf-ipanel__row-value">
        <div className="kf-chips kf-chips--reach">
          {list.map((u) => {
            // A unit is "reachable" when there is a path from EA or
            // the ingredient's base_unit to it. We check from EA as
            // the common root; ingredients that are themselves per
            // lb/gal reach OZ / FLOZ / GAL via built-in same-dim
            // conversions.
            const reachable =
              factor("EA", u, m) != null || factor("LB", u, m) != null || factor("FLOZ", u, m) != null;
            if (reachable) {
              return (
                <span key={u} className="kf-chip kf-chip--solid" aria-label={`Reaches ${u}`}>
                  {uomLabel(u)}
                </span>
              );
            }
            return (
              <button
                key={u}
                type="button"
                className="kf-chip kf-chip--dashed"
                onClick={() => onAddForUom?.(u)}
                aria-label={`Add a measure to reach ${u}`}
              >
                {uomLabel(u)}: add a measure
              </button>
            );
          })}
        </div>
      </div>
      <div className="kf-ipanel__row-action" />
    </div>
  );
}
