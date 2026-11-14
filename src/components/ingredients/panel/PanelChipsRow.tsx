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
  // T3 R3 T1 follow-up: a chip that names a specific target preselects
  // it (pickUnit omitted / false). The `each` chip on a weight or
  // volume ingredient has no sensible target (the measure writes from
  // EA, to ???), so it passes pickUnit=true + uom="" meaning "open
  // the add row blank, exactly as the local + Add a measure button
  // opens it" - no preselected weight unit, which M2 ruled out.
  onAddForUom?: (uom: string, pickUnit?: boolean) => void;
}) {
  const baseCanonical = canonicalFromBaseUnit(ingredient.base_unit);
  // M2.1 fix 3: fold count-flavour pack uoms (CT, PC, PCS, DZ) into
  // EA before building the reach set and the chip list. Weight and
  // volume units pass through unchanged.
  const normalizedItemUnits = itemUnits
    .map((u) => normalizeChipUom(u))
    .filter((u): u is string => u != null);

  // Starting units for reach: the ingredient's base_unit + every
  // unit the linked items touch. Deduped + upper-cased.
  const startSet = new Set<string>();
  if (baseCanonical) startSet.add(baseCanonical);
  for (const u of normalizedItemUnits) startSet.add(u);
  const starts = Array.from(startSet);

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
            // T3 R3 T1 follow-up: a count target (each, dozen) on a
            // weight or volume ingredient renders as a dashed "add a
            // measure" button. Clicking it opens the add row BLANK -
            // from `each`, to-unit empty, user picks. Round 2 had
            // this chip preselect baseCanonical as the to-unit, so
            // the add row showed "1 each = [blank] lb"; M2 ruled
            // that a default is a decision (2.5 oz once saved as
            // 2.5 lb). The dead "no path" chip was wrong too - the
            // bridge is the most common measure in the app.
            const td = DIM_BY_UOM[u];
            const bd = baseCanonical ? DIM_BY_UOM[baseCanonical] : undefined;
            if (td === "count" && (bd === "weight" || bd === "volume") && baseCanonical) {
              return (
                <button
                  key={u}
                  type="button"
                  className="kf-chip kf-chip--dashed"
                  onClick={() => onAddForUom?.("", true)}
                  aria-label={`Add a measure to reach ${u}`}
                >
                  {uomLabel(u)}: add a measure
                </button>
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
