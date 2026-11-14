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

// M2.1 fix 3: pack UOMs the system treats as count rather than a
// true unit of measure. CT and PC are inventory counters, not
// "pieces" in a bridge sense - the chip bar should fold them into
// EA so no "pc" / "ct" chip ever renders. The mapping also drives
// reach: an item priced in CT is effectively priced in EA.
const COUNT_UOMS = new Set<string>(["EA", "CT", "PC", "PCS", "DZ", "DOZEN"]);
function normalizeChipUom(uom: string): string | null {
  const up = uom.toUpperCase();
  if (COUNT_UOMS.has(up)) return "EA";
  if (!DIM_BY_UOM[up]) return null;
  return up;
}

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
  // M2.1 fix 3: fold count-flavour pack uoms (CT, PC, PCS, DZ) into
  // EA before the chip list is built. Weight and volume units pass
  // through unchanged.
  const normalizedItemUnits = itemUnits
    .map((u) => normalizeChipUom(u))
    .filter((u): u is string => u != null);

  // Chips to display: the core five plus any other weight or volume
  // unit an item is actually priced in. Count-flavour uoms were
  // already folded into EA above, so "pc" / "ct" never reaches here.
  const seen = new Set<string>();
  const list: string[] = [];
  for (const u of [...CORE_UNITS, ...normalizedItemUnits]) {
    const dim = DIM_BY_UOM[u];
    if (!dim) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    list.push(u);
  }

  const m = { measures };

  // T1 fix 4: a unit chip is lit only when the ingredient's blended
  // price can be expressed in that unit. Same kind as the ingredient's
  // own unit (lb / oz / g / kg, gal / qt / pt / floz / l / ml, each /
  // dozen) reaches via built-in TO_BASE; cross-kind reaches only when
  // the ingredient's own measures bridge it. Linked items' pack units
  // play no part - one count-packed item no longer makes `each` look
  // usable on a per-lb ingredient with no measure.
  function isReachable(target: string): boolean {
    if (!baseCanonical) return false;
    return factor(baseCanonical, target, m) != null;
  }

  // Dashed prefill: the bridge that would REACH the target from the
  // ingredient's own base unit. Weight / volume target with a count
  // base -> count-to-weight / count-to-volume from EA. Weight target
  // with a volume base -> volume-to-weight from FLOZ (the typical
  // volume uom). Count target with a weight / volume base -> prefill
  // EA; the user picks the right from-unit.
  function prefillFromFor(target: string): string {
    const bd = baseCanonical ? DIM_BY_UOM[baseCanonical] : undefined;
    const td = DIM_BY_UOM[target];
    if (td === "weight" || td === "volume") {
      if (bd === "count") return "EA";
      if (td === "weight" && bd === "volume") return "FLOZ";
      if (td === "volume" && bd === "weight") return "FLOZ";
      return "EA";
    }
    // Count target - prefill the base when it is a volume uom, else EA.
    if (bd === "volume" && baseCanonical) return baseCanonical;
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
