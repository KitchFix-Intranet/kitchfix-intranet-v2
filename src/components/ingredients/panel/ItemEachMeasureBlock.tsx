"use client";

// N11 §2: item-side each measure. Explicit Save button; auto-save on
// blur/change/untick is gone. Owns its row (label + value + action) so
// Save sits in the standard row-action column per R4. PanelItemZone
// mounts this component as row 2 directly.
//
// State matrix (identical strings across all three each-measure
// editors per R1):
//   Clean               Save line-variant, disabled; no note line.
//   Dirty + invalid     Save line-variant, disabled; hint (Enter a
//                       number / Pick a unit).
//   Dirty + valid       Save primary, enabled; note "Not saved yet ·
//                       Discard".
// Untick on a stored measure is dirty+valid (removes it).
//
// R2 baseline rule: a prop change always updates the baseline; the
// draft is re-seeded only when the item id changes OR the draft was
// already in sync with the prior stored values. A refresh never
// wipes a dirty draft on the same item.

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { postJson, errMsg } from "./common";

type Draft = { hasOwn: boolean; qty: string; uom: string };

function makeDraft(item: ReviewGroupItem): Draft {
  if (item.eachMeasure == null) return { hasOwn: false, qty: "", uom: "" };
  return {
    hasOwn: true,
    qty: String(item.eachMeasure.qty),
    uom: item.eachMeasure.uom.toUpperCase(),
  };
}

function equal(a: Draft, b: Draft) {
  return a.hasOwn === b.hasOwn && a.qty === b.qty && a.uom === b.uom;
}

export function ItemEachMeasureBlock({
  item,
  ingredient: _ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const [baseline, setBaseline] = useState<Draft>(() => makeDraft(item));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevId = useRef(item.id);
  const priorStoredRef = useRef<Draft>(baseline);

  useEffect(() => {
    const next = makeDraft(item);
    const idChanged = prevId.current !== item.id;
    const priorStored = priorStoredRef.current;
    prevId.current = item.id;
    priorStoredRef.current = next;
    setBaseline(next);
    setDraft((cur) => (idChanged || equal(cur, priorStored) ? next : cur));
  }, [item.id, item.eachMeasure?.qty, item.eachMeasure?.uom]);

  const dirty = !equal(draft, baseline);
  const qtyTrimmed = draft.qty.trim();
  const qtyNum = Number(qtyTrimmed);
  const qtyValid = qtyTrimmed !== "" && Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= 100000;
  const uomDim = DIM_BY_UOM[draft.uom];
  const uomValid = uomDim === "weight" || uomDim === "volume";

  const removing = dirty && !draft.hasOwn && baseline.hasOwn;
  const writing = dirty && draft.hasOwn && qtyValid && uomValid;
  const saveEnabled = !busy && (removing || writing);

  const hint =
    draft.hasOwn && qtyTrimmed === "" ? "Enter a number"
    : draft.hasOwn && qtyValid && !uomValid ? "Pick a unit"
    : null;

  async function doSave() {
    if (!saveEnabled) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> =
      draft.hasOwn
        ? { itemId: item.id, qty: qtyNum, uom: draft.uom }
        : { itemId: item.id, qty: null };
    const r = await postJson("/api/review/set-item-each-measure", body);
    if (!r.ok) {
      const msg = errMsg(r.data, draft.hasOwn ? `Save failed (${r.status})` : `Clear failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    if (draft.hasOwn) {
      toast(`Saved: this each is ${Math.round(qtyNum * 10000) / 10000} ${uomLabel(draft.uom)}`);
    } else {
      toast("Item measure cleared");
    }
    const saved: Draft = draft.hasOwn
      ? { hasOwn: true, qty: String(qtyNum), uom: draft.uom }
      : { hasOwn: false, qty: "", uom: "" };
    priorStoredRef.current = saved;
    setBaseline(saved);
    setDraft(saved);
    setBusy(false);
    onDone();
  }

  function onDiscard() {
    if (busy) return;
    setDraft(baseline);
    setError(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" && saveEnabled) {
      e.preventDefault();
      void doSave();
    } else if (e.key === "Escape" && dirty) {
      e.preventDefault();
      onDiscard();
    }
  }

  return (
    <div className="kf-ipanel__row">
      <div className="kf-ipanel__row-label">One each is</div>
      <div className="kf-ipanel__row-value">
        <div className="kf-ipanel__itemmeasure">
          <label className="kf-ipanel__itemmeasure-check">
            <input
              type="checkbox"
              checked={draft.hasOwn}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setDraft((d) => ({ ...d, hasOwn: next }));
              }}
              disabled={busy}
            />
            <span>Different from the ingredient</span>
          </label>
          {draft.hasOwn ? (
            <div className="kf-ipanel__itemmeasure-fields">
              <input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                className="kf-ipanel__ctl kf-ipanel__ctl--qty"
                value={draft.qty}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => ({ ...d, qty: v }));
                }}
                onKeyDown={onKey}
                aria-label="This item's each weighs"
                disabled={busy}
              />
              <select
                className="kf-ipanel__ctl kf-ipanel__ctl--uom"
                value={draft.uom}
                onChange={(e) => {
                  const v = e.target.value.toUpperCase();
                  setDraft((d) => ({ ...d, uom: v }));
                }}
                onKeyDown={onKey}
                disabled={busy}
                aria-label="Weight unit for this item"
              >
                <option value="" disabled>Unit</option>
                <optgroup label="Weight">
                  {WEIGHT_UOMS.map((u) => (
                    <option key={u} value={u}>{uomLabel(u)}</option>
                  ))}
                </optgroup>
                <optgroup label="Volume">
                  {VOLUME_UOMS.map((u) => (
                    <option key={u} value={u}>{uomLabel(u)}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          ) : !dirty ? (
            <span className="kf-ipanel__itemmeasure-hint">Tick if this case holds a different size</span>
          ) : null}
        </div>
        {dirty ? (
          <div className="kf-ipanel__measure-note kf-ipanel__measure-note--dirty" aria-live="polite">
            {hint ? (
              <span>{hint}</span>
            ) : removing ? (
              <>
                <span>Will use the ingredient&rsquo;s measure</span>
                <span aria-hidden>&middot;</span>
                <span>not saved yet</span>
                <span aria-hidden>&middot;</span>
                <button
                  type="button"
                  className="kf-ipanel__measure-discard"
                  onClick={onDiscard}
                  disabled={busy}
                >
                  Discard
                </button>
              </>
            ) : (
              <>
                <span>Not saved yet</span>
                <span aria-hidden>&middot;</span>
                <button
                  type="button"
                  className="kf-ipanel__measure-discard"
                  onClick={onDiscard}
                  disabled={busy}
                >
                  Discard
                </button>
              </>
            )}
            {error ? <span className="kf-ipanel__measure-error">{error}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="kf-ipanel__row-action">
        {(draft.hasOwn || baseline.hasOwn) ? (
          <button
            type="button"
            className={`kf-btn ${saveEnabled ? "kf-btn--primary" : "kf-btn--line"} kf-btn--sm${busy ? " is-busy" : ""}`}
            disabled={!saveEnabled}
            onClick={doSave}
            onKeyDown={onKey}
          >
            {busy ? "Saving..." : "Save"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
