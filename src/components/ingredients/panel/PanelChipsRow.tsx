"use client";

// M2 §4B §2.6: "Recipes can use" chips. A unit is REACHABLE when a
// path exists from one of the ingredient's "starting units" to it -
// those are the units linked items are priced in, plus base_unit,
// plus any uom a linked item's pack states (weight / volume side of
// a sized pack). A dashed chip prefills the add row with the
// bridge that would reach it, from EA or a volume uom as needed.

import type { Measure } from "@/lib/ingredients/measures";
import { factor } from "@/lib/ingredients/measures";
import { DIM_BY_UOM, canonicalFromBaseUnit, uomLabel } from "@/lib/ingredients/pack";
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
  // Units linked items are actually priced in (base_uom values) +
  // uoms their packs state as sized packs. Chip reach is checked
  // from THIS set, not from EA/LB/FLOZ unconditionally.
  itemUnits?: readonly string[];
  onAddForUom?: (uom: string) => void;
}) {
  const baseCanonical = canonicalFromBaseUnit(ingredient.base_unit);
  // Starting units for reach: the ingredient's base_unit + every
  // unit the linked items touch. Deduped + upper-cased.
  const startSet = new Set<string>();
  if (baseCanonical) startSet.add(baseCanonical);
  for (const u of itemUnits) {
    const up = u.toUpperCase();
    if (DIM_BY_UOM[up]) startSet.add(up);
  }
  const starts = Array.from(startSet);

  // Chips to display: the core five + any item uoms not in core.
  const seen = new Set<string>();
  const list: string[] = [];
  for (const u of [...CORE_UNITS, ...itemUnits]) {
    const up = u.toUpperCase();
    if (!DIM_BY_UOM[up]) continue;
    if (seen.has(up)) continue;
    seen.add(up);
    list.push(up);
  }

  const m = { measures };

  // Reach: ANY path from one of the starting units to the target
  // yields a non-null factor. Same-dim is always reachable (built-in
  // TO_BASE), so a per-lb ingredient with LB items always reaches OZ
  // / G / KG without a measure. A cross-dim chip only solidifies
  // when a measure bridges it.
  function isReachable(target: string): boolean {
    if (starts.length === 0) return false;
    for (const s of starts) {
      if (factor(s, target, m) != null) return true;
    }
    return false;
  }

  // Dashed prefill: the bridge that would REACH the target from one
  // of the starting dims. Weight / volume target with a count start
  // -> count-to-weight / count-to-volume, i.e. from EA. Weight
  // target with a volume start -> volume-to-weight from a volume
  // uom (pick FLOZ as the sensible default). Count target with a
  // weight start -> volume-to-weight is not count-reaching; refuse.
  function prefillFromFor(target: string): string {
    const td = DIM_BY_UOM[target];
    const startDims = new Set(starts.map((s) => DIM_BY_UOM[s]));
    if (td === "weight" || td === "volume") {
      if (startDims.has("count")) return "EA";
      if (td === "weight" && startDims.has("volume")) return "FLOZ";
      if (td === "volume" && startDims.has("weight")) return "FLOZ"; // volume start absent; FLOZ falls through to cover + rejectReason will guide
      return "EA";
    }
    // Count target - needs count start somewhere, or volume-to-weight
    // + inverse. Prefill the first volume start the ingredient has;
    // if none, EA (the user will edit).
    for (const s of starts) {
      if (DIM_BY_UOM[s] === "volume") return s;
    }
    return "EA";
  }

  return (
    <div className="kf-ipanel__row kf-ipanel__row--chips">
      <div className="kf-ipanel__row-label">
        <span>Recipes can use</span>
      </div>
      <div className="kf-ipanel__row-value">
        <div className="kf-chips kf-chips--reach">
          {list.map((u) => {
            const reachable = isReachable(u);
            if (reachable) {
              return (
                <span key={u} className="kf-chip kf-chip--solid" aria-label={`Reaches ${u}`}>
                  {uomLabel(u)}
                </span>
              );
            }
            const from = prefillFromFor(u);
            // Never prefill EA to EA (same-dim, not a measure).
            if (from === u) {
              return (
                <span key={u} className="kf-chip kf-chip--dashed kf-chip--dead" aria-label={`${u} not reachable`}>
                  {uomLabel(u)}: no path
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
