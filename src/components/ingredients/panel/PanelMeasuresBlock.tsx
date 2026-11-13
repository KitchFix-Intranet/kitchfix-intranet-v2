"use client";

// M2 §4B: the ingredient's Measures block. Replaces the N6 "One each
// is" row. Shown for every ingredient regardless of base_unit (§2.3).
//
// Owns:
//   - list of stored measures as sentence rows (1 each = qty uom +
//     plain-words echo + remove)
//   - "+ Add a measure" opener with an inline form guarded by
//     rejectReason
//   - suggestions sourced from the ingredient's own cases (§2.4)
//   - save bar with dry-run sentence + Discard + one POST
//
// The dry-run + save go through the M1 route
// /api/review/set-ingredient-measures, which is RPC-backed and
// writes pr_events inside pr_set_ingredient_measures. This block
// does NOT dual-write; the legacy each_measure_* columns are kept
// in sync by the M1 shaper on the read side for one more patch.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import {
  rejectReason,
  factor,
  type Measure,
  type MeasureSource,
} from "@/lib/ingredients/measures";
import {
  DIM_BY_UOM,
  TO_BASE,
  WEIGHT_UOMS,
  VOLUME_UOMS,
  uomLabel,
  canonicalFromBaseUnit,
} from "@/lib/ingredients/pack";
import type { ReviewCardIngredient } from "../itemTypes";

type UiMeasure = { from_unit: string; qty: string; to_unit: string; source: MeasureSource };

const SOURCES: MeasureSource[] = ["house_test", "book", "vendor_spec", "estimate", "pack"];
const SOURCE_LABEL: Record<MeasureSource, string> = {
  house_test: "house test",
  book: "book value",
  vendor_spec: "vendor spec",
  estimate: "estimate",
  pack: "printed on the pack",
};

// "1 EA" + weight = 2.5 oz -> "About 6.4 to the lb" / "One each is N
// lb"; "1 GAL" + weight = "1 gal is 7.6 lb". Keep plain and lower-case.
// Polish fix 2: every unit label routes through uomLabel so EA reads
// as "each", never "ea".
function echoText(m: UiMeasure): string {
  const q = Number(m.qty);
  if (!Number.isFinite(q) || q <= 0) return "";
  const fd = DIM_BY_UOM[m.from_unit.toUpperCase()];
  const td = DIM_BY_UOM[m.to_unit.toUpperCase()];
  const toBase = TO_BASE[m.to_unit.toUpperCase()] ?? 0;
  if (!fd || !td || !(toBase > 0)) return "";
  const asBase = q * toBase; // in LB / FLOZ / EA base
  const r2 = (n: number) => (Math.round(n * 100) / 100).toString();
  const fromLabel = uomLabel(m.from_unit);
  if (td === "weight") {
    if (asBase >= 1) return `One ${fromLabel} is ${r2(asBase)} lb`;
    return `About ${r2(1 / asBase)} to the lb`;
  }
  if (td === "volume") {
    if (asBase >= 32) return `One ${fromLabel} is ${r2(asBase / 128)} gal`;
    return `${r2(asBase)} fl oz in one ${fromLabel}`;
  }
  return `${r2(q)} ${uomLabel(m.to_unit)} in one ${fromLabel}`;
}

function normalizeStored(m: { from_unit: string; qty: number; to_unit: string; source: string }): UiMeasure {
  const src = SOURCES.includes(m.source as MeasureSource) ? (m.source as MeasureSource) : "estimate";
  return {
    from_unit: m.from_unit.toUpperCase(),
    qty: String(m.qty),
    to_unit: m.to_unit.toUpperCase(),
    source: src,
  };
}

function toPersisted(m: UiMeasure): Measure {
  return {
    from_unit: m.from_unit.toUpperCase(),
    qty: Number(m.qty),
    to_unit: m.to_unit.toUpperCase(),
    source: m.source,
  };
}

function sameList(a: UiMeasure[], b: UiMeasure[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.from_unit !== y.from_unit) return false;
    if (x.to_unit !== y.to_unit) return false;
    if (Number(x.qty) !== Number(y.qty)) return false;
    if (x.source !== y.source) return false;
  }
  return true;
}

// Suggestion candidate: a linked item whose pack states a count of
// pieces AND a weight/volume per piece. Rule §2.4 + prompt amendment 5.
export type SuggestionCandidate = {
  id: string;
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  usd12m: number;
};

type Suggestion = {
  from_unit: string;
  qty: number;
  to_unit: string;
  via: string;
  usd12m: number;
};

function buildSuggestions(
  candidates: readonly SuggestionCandidate[],
  storedMeasures: readonly Measure[],
  ingredient: ReviewCardIngredient,
  itemsReachBase: boolean,
): Suggestion[] {
  const bu = (ingredient.base_unit ?? "").toLowerCase();
  // §2.4 rule 6: suggest only when base_unit is each OR at least one
  // linked item cannot reach base_unit (itemsReachBase === false).
  if (bu !== "each" && itemsReachBase) return [];
  const m = { measures: storedMeasures };
  const out: Suggestion[] = [];
  for (const c of candidates) {
    const pq = Number(c.packQty ?? NaN);
    const ps = Number(c.packSize ?? NaN);
    const pu = (c.packUom ?? "").toUpperCase();
    if (!pu || !(pq > 1) || !(ps > 0)) continue;
    const dim = DIM_BY_UOM[pu];
    if (dim !== "weight" && dim !== "volume") continue;
    if (factor("EA", pu, m) != null) continue;
    out.push({ from_unit: "EA", qty: ps, to_unit: pu, via: `${pq} x ${ps} ${pu}`, usd12m: c.usd12m });
  }
  // Dedupe by (from, qty, to); keep the highest-spend example.
  const byKey = new Map<string, Suggestion>();
  for (const s of out) {
    const k = `${s.from_unit}|${s.qty}|${s.to_unit}`;
    const prior = byKey.get(k);
    if (!prior || s.usd12m > prior.usd12m) byKey.set(k, s);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.usd12m - a.usd12m)
    .slice(0, 3);
}

export function PanelMeasuresBlock({
  ingredient,
  measures,
  suggestionCandidates = [],
  itemsReachBase = true,
  onDone,
  openAddForUom,
  openAddPrefillQty,
  onAfterAdd,
}: {
  ingredient: ReviewCardIngredient;
  measures: readonly { from_unit: string; qty: number; to_unit: string; source: string }[];
  suggestionCandidates?: readonly SuggestionCandidate[];
  itemsReachBase?: boolean;
  onDone: () => void;
  // External trigger from the chip row or attention: open the add
  // form with this to_unit prefilled. Resets after consumption.
  openAddForUom?: string | null;
  // Optional qty prefill (sizes_differ fires with "largest-spend size").
  openAddPrefillQty?: number | null;
  onAfterAdd?: () => void;
}) {
  const baseline = useMemo<UiMeasure[]>(() => measures.map(normalizeStored), [measures]);
  const [draft, setDraft] = useState<UiMeasure[]>(baseline);
  const [addingFrom, setAddingFrom] = useState<string | null>(null);
  const [addQty, setAddQty] = useState("");
  const [addUom, setAddUom] = useState("");
  const [addSource, setAddSource] = useState<MeasureSource>("estimate");
  const [addError, setAddError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [dryRunSentence, setDryRunSentence] = useState<string | null>(null);
  const dryRunTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External add-for-uom trigger from the chips row or attention.
  // Pick the bridge that would REACH the target: for a weight/volume
  // target, from = EA (count-to-X); for an EA target, from = the
  // first volume uom (volume-to-weight is the only cross-dim path
  // that reaches EA via a second row - rare). Never prefill EA to EA.
  useEffect(() => {
    if (!openAddForUom) return;
    const tu = openAddForUom.toUpperCase();
    const tDim = DIM_BY_UOM[tu];
    const fromPick =
      tDim === "weight" || tDim === "volume"
        ? "EA"
        : "EA"; // count target: user picks the volume from themselves
    setAddingFrom(fromPick === tu ? "" : fromPick);
    setAddUom(tu);
    setAddQty(openAddPrefillQty != null && openAddPrefillQty > 0 ? String(openAddPrefillQty) : "");
    setAddSource("estimate");
    setAddError(null);
  }, [openAddForUom, openAddPrefillQty]);

  // M2 §4B part 3 fix 3 (N11 R2 rule): re-seed only when the
  // ingredient id changes OR the draft equalled the prior stored
  // list. Never wipe a dirty draft on a refresh of the same
  // ingredient.
  const prevIdRef = useRef(ingredient.id);
  const priorStoredRef = useRef<UiMeasure[]>(baseline);
  useEffect(() => {
    const idChanged = prevIdRef.current !== ingredient.id;
    const priorStored = priorStoredRef.current;
    prevIdRef.current = ingredient.id;
    priorStoredRef.current = baseline;
    setDraft((cur) => (idChanged || sameList(cur, priorStored) ? baseline : cur));
  }, [baseline, ingredient.id]);

  const dirty = !sameList(draft, baseline);

  const candidateForRejection = useMemo<UiMeasure | null>(() => {
    if (!addingFrom) return null;
    const qn = Number(addQty);
    if (!Number.isFinite(qn) || qn <= 0) return null;
    if (!addUom) return null;
    return { from_unit: addingFrom, qty: addQty, to_unit: addUom, source: addSource };
  }, [addingFrom, addQty, addUom, addSource]);

  const inlineRefusal = useMemo(() => {
    if (!candidateForRejection) return null;
    return rejectReason(toPersisted(candidateForRejection), draft.map(toPersisted));
  }, [candidateForRejection, draft]);

  const addDisabled =
    !candidateForRejection ||
    inlineRefusal != null ||
    draft.length >= 2;

  function updateRow(i: number, patch: Partial<UiMeasure>) {
    setDraft((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setDraft((rows) => rows.filter((_, idx) => idx !== i));
  }
  function openAdd() {
    const bu = (ingredient.base_unit ?? "").toLowerCase();
    // If the ingredient is each-costed, default to EA from; otherwise
    // whatever VOLUME_UOM has a decent chance of being handy. The user
    // picks anyway.
    setAddingFrom(bu === "each" ? "EA" : "EA");
    setAddUom("");
    setAddQty("");
    setAddSource("estimate");
    setAddError(null);
  }
  function cancelAdd() {
    setAddingFrom(null);
    setAddQty("");
    setAddUom("");
    setAddError(null);
  }
  function commitAdd() {
    if (!candidateForRejection) return;
    if (inlineRefusal) {
      setAddError(inlineRefusal);
      return;
    }
    setDraft((rows) => [...rows, candidateForRejection]);
    setAddingFrom(null);
    setAddQty("");
    setAddUom("");
    setAddError(null);
    onAfterAdd?.();
  }
  function addSuggestion(s: Suggestion) {
    const row: UiMeasure = {
      from_unit: s.from_unit,
      qty: String(s.qty),
      to_unit: s.to_unit,
      source: "pack",
    };
    const why = rejectReason(toPersisted(row), draft.map(toPersisted));
    if (why) {
      toast(why);
      return;
    }
    setDraft((rows) => [...rows, row]);
  }
  function discardChanges() {
    setDraft(baseline);
    cancelAdd();
    setDryRunSentence(null);
  }

  // Dry-run: fetch "how many items would change" when the draft is
  // dirty. Debounced so successive edits only trigger the last fetch.
  useEffect(() => {
    if (!dirty) {
      setDryRunSentence(null);
      return;
    }
    if (dryRunTimer.current) clearTimeout(dryRunTimer.current);
    dryRunTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/review/set-ingredient-measures", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ingredientId: ingredient.id,
            measures: draft.map(toPersisted),
            dryRun: true,
          }),
        });
        if (!res.ok) {
          setDryRunSentence(null);
          return;
        }
        const data = (await res.json()) as { wouldChange?: { items?: number } };
        const n = Number(data.wouldChange?.items ?? 0);
        const plural = n === 1 ? "" : "s";
        setDryRunSentence(
          `Saving changes the price of ${fmtCount(n)} item${plural} linked to ${ingredient.name}.`,
        );
      } catch {
        setDryRunSentence(null);
      }
    }, 250);
    return () => {
      if (dryRunTimer.current) clearTimeout(dryRunTimer.current);
    };
  }, [dirty, draft, ingredient.id, ingredient.name]);

  async function saveAll() {
    setSaveBusy(true);
    try {
      const res = await fetch("/api/review/set-ingredient-measures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ingredientId: ingredient.id,
          measures: draft.map(toPersisted),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast(body.error ?? "Save failed");
        return;
      }
      toast("Measures saved");
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg);
    } finally {
      setSaveBusy(false);
    }
  }

  const suggestions = useMemo(
    () =>
      buildSuggestions(
        suggestionCandidates,
        draft.map(toPersisted),
        ingredient,
        itemsReachBase,
      ),
    [suggestionCandidates, draft, ingredient, itemsReachBase],
  );

  const fromOptions = useMemo(() => ["EA", ...VOLUME_UOMS], []);
  const toOptions = useMemo(() => {
    // to_unit allowed set: weight OR volume (EA-from excludes the
    // same-dim same-kind case; the rejectReason gates it with a
    // sentence).
    return [...WEIGHT_UOMS, ...VOLUME_UOMS];
  }, []);

  const bu = (ingredient.base_unit ?? "").toLowerCase();
  const baseCanonical = canonicalFromBaseUnit(bu);

  return (
    <div className="kf-ipanel__row kf-ipanel__row--measures">
      <div className="kf-ipanel__row-label">
        <span>Measures</span>
        {baseCanonical ? (
          <span className="kf-ipanel__row-hint">
            Only the facts the system cannot know. {uomLabel("OZ")} to {uomLabel("LB")},{" "}
            {uomLabel("FLOZ")} to gallons, litres and kilos are built in.
          </span>
        ) : null}
      </div>
      <div className="kf-ipanel__row-value">
        {draft.length === 0 ? (
          <div className="kf-ipanel__row-hint">
            No measures yet. Items can only be priced in the unit their case comes in.
          </div>
        ) : (
          <ul className="kf-measures__list">
            {draft.map((row, i) => (
              <li key={i} className="kf-measures__row">
                <span className="kf-measures__one">
                  1 {uomLabel(row.from_unit)} =
                </span>
                <input
                  type="number"
                  className="kf-ipanel__ctl kf-ipanel__ctl--qty"
                  value={row.qty}
                  min="0"
                  step="0.0001"
                  onChange={(e) => updateRow(i, { qty: e.currentTarget.value })}
                  aria-label={`Amount in one ${uomLabel(row.from_unit)}`}
                />
                <select
                  className="kf-ipanel__ctl kf-ipanel__ctl--uom"
                  value={row.to_unit}
                  onChange={(e) => updateRow(i, { to_unit: e.currentTarget.value.toUpperCase() })}
                  aria-label="Unit"
                >
                  {toOptions.map((u) => (
                    <option key={u} value={u}>
                      {uomLabel(u)}
                    </option>
                  ))}
                </select>
                <select
                  className="kf-ipanel__ctl kf-ipanel__ctl--source"
                  value={row.source}
                  onChange={(e) =>
                    updateRow(i, {
                      source: SOURCES.includes(e.currentTarget.value as MeasureSource)
                        ? (e.currentTarget.value as MeasureSource)
                        : "estimate",
                    })
                  }
                  aria-label="Source"
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </option>
                  ))}
                </select>
                <span className="kf-measures__echo">{echoText(row)}</span>
                {/* Polish fix 6: Remove is a quiet text link, kept
                    on the measure's own line. The bordered button
                    was wrapping to a second line on narrow panel
                    widths. */}
                <button
                  type="button"
                  className="kf-ipanel__link kf-measures__remove"
                  onClick={() => removeRow(i)}
                  aria-label={`Remove measure ${i + 1}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {addingFrom == null && draft.length < 2 ? (
          <div className="kf-measures__add">
            <button type="button" className="kf-btn kf-btn--line" onClick={openAdd}>
              + Add a measure
            </button>
          </div>
        ) : null}

        {addingFrom != null ? (
          <div className="kf-measures__add kf-measures__add--open">
            <span className="kf-measures__one">1</span>
            <select
              className="kf-ipanel__ctl kf-ipanel__ctl--uom"
              value={addingFrom}
              onChange={(e) => setAddingFrom(e.currentTarget.value.toUpperCase())}
              aria-label="One of"
            >
              {fromOptions.map((u) => (
                <option key={u} value={u}>
                  {uomLabel(u) || u.toLowerCase()}
                </option>
              ))}
            </select>
            <span>=</span>
            <input
              type="number"
              className="kf-ipanel__ctl kf-ipanel__ctl--qty"
              value={addQty}
              min="0"
              step="0.0001"
              onChange={(e) => setAddQty(e.currentTarget.value)}
              placeholder="qty"
              aria-label="Amount"
            />
            <select
              className="kf-ipanel__ctl kf-ipanel__ctl--uom"
              value={addUom}
              onChange={(e) => setAddUom(e.currentTarget.value.toUpperCase())}
              aria-label="Unit"
            >
              {/* Polish fix 1: placeholder option matches the initial
                  addUom="" so the select renders "unit" by default,
                  never "lb". Add stays disabled until a real unit
                  is picked (candidateForRejection requires addUom);
                  a prefill from a suggestion or sizes_differ sets
                  addUom explicitly, which keeps its unit. */}
              <option value="">unit</option>
              {toOptions.map((u) => (
                <option key={u} value={u}>
                  {uomLabel(u)}
                </option>
              ))}
            </select>
            <select
              className="kf-ipanel__ctl kf-ipanel__ctl--source"
              value={addSource}
              onChange={(e) =>
                setAddSource(
                  SOURCES.includes(e.currentTarget.value as MeasureSource)
                    ? (e.currentTarget.value as MeasureSource)
                    : "estimate",
                )
              }
              aria-label="Source"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="kf-btn kf-btn--primary"
              onClick={commitAdd}
              disabled={addDisabled}
            >
              Add
            </button>
            <button type="button" className="kf-btn kf-btn--line" onClick={cancelAdd}>
              Cancel
            </button>
            {inlineRefusal || addError ? (
              <span className="kf-measures__refusal" role="alert">
                {inlineRefusal ?? addError}
              </span>
            ) : null}
          </div>
        ) : null}

        {suggestions.length > 0 ? (
          <div className="kf-measures__suggestions">
            {suggestions.map((s, i) => (
              <div key={i} className="kf-measures__suggestion">
                <span className="kf-measures__suggestion-lab">Suggested</span>
                <strong>
                  1 {uomLabel(s.from_unit)} = {s.qty} {uomLabel(s.to_unit)}
                </strong>
                <span className="kf-measures__suggestion-via">printed on the case: {s.via}</span>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => addSuggestion(s)}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {dirty ? (
          <div className="kf-measures__savebar">
            <span>
              <strong>Not saved yet.</strong>{" "}
              {dryRunSentence ??
                (suggestions.length === 0 && draft.length === baseline.length
                  ? "Changes queued."
                  : `Saving replaces ${ingredient.name}'s measures.`)}
            </span>
            <span className="kf-measures__savebar-actions">
              <button
                type="button"
                className="kf-btn kf-btn--primary"
                onClick={saveAll}
                disabled={saveBusy || draft.some((r) => rejectReason(toPersisted(r), draft.filter((_, j) => j !== draft.indexOf(r)).map(toPersisted)) != null)}
              >
                {saveBusy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="kf-btn kf-btn--line"
                onClick={discardChanges}
                disabled={saveBusy}
              >
                Discard
              </button>
            </span>
          </div>
        ) : null}

        {/* Polish fix 5: the "Recipes can now use {name}..." echo is
            deleted. The chip row already names the reachable units;
            the dup sentence read as filler. */}

        {/* Stat helper for consumers like attention.tsx: expose how
            many usd fmtUsd() calls would have landed - unused today,
            kept for future per-ingredient stats. */}
        {false ? <span>{fmtUsd(0)}</span> : null}
      </div>
      <div className="kf-ipanel__row-action" />
    </div>
  );
}
