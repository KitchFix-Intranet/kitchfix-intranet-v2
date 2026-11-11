"use client";

// N6: this item's own each_measure override when its each is a
// different size than the ingredient's. Reveals qty + uom inputs and
// routes through /api/review/set-item-each-measure. The comparison
// line goes through deriveRecipePrice so the math matches the review
// card and the detail panel never divides on its own.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtUsd } from "@/lib/fmt";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/eachMeasure";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";

export function ItemEachMeasureBlock({
  item,
  ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const [hasOwn, setHasOwn] = useState<boolean>(item.eachMeasure != null);
  const [qtyDraft, setQtyDraft] = useState<string>(
    item.eachMeasure == null ? "" : String(item.eachMeasure.qty)
  );
  const [uomDraft, setUomDraft] = useState<string>(
    (item.eachMeasure?.uom ?? "LB").toUpperCase()
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // N7 B5: four behaviours.
  //   (a) unit change saves when the number is valid (no Save click);
  //   (b) unticking a saved value clears immediately + shows Saved;
  //   (c) unticking with nothing saved only hides fields (no write);
  //   (d) ticking writes nothing until a valid number lands.

  async function saveValue(n: number, u: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-item-each-measure", {
      itemId: item.id,
      qty: n,
      uom: u,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      // Revert drafts to the stored value on failure.
      setQtyDraft(item.eachMeasure == null ? "" : String(item.eachMeasure.qty));
      setUomDraft((item.eachMeasure?.uom ?? "LB").toUpperCase());
      setBusy(false);
      return;
    }
    toast(`Saved: this each is ${Math.round(n * 10000) / 10000} ${uomLabel(u)}`);
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
  }

  async function clearStored() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-item-each-measure", {
      itemId: item.id,
      qty: null,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Clear failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      // Revert tick state on failure.
      setHasOwn(true);
      setBusy(false);
      return;
    }
    toast("Item measure cleared");
    setQtyDraft("");
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
  }

  // Attempt to save the current drafts; silent no-op if the draft is
  // empty / invalid / same-as-stored. Used by qty-blur and unit-change.
  function trySave() {
    if (!hasOwn) return;
    const trimmed = qtyDraft.trim();
    if (trimmed === "") return;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return;
    const u = uomDraft.toUpperCase();
    const dim = DIM_BY_UOM[u];
    if (dim !== "weight" && dim !== "volume") return;
    const stored = item.eachMeasure;
    if (stored != null && Number(stored.qty) === n && stored.uom.toUpperCase() === u) return;
    void saveValue(n, u);
  }

  function onTickChange(next: boolean) {
    setHasOwn(next);
    if (!next) {
      // B5(b): untick with a saved value clears immediately.
      // B5(c): untick with nothing saved is a visual no-op.
      if (item.eachMeasure != null) void clearStored();
    }
    // B5(d): ticking writes nothing until a valid number lands in trySave.
  }

  // Comparison lines: run deriveRecipePrice once with the item's measure
  // and once with the ingredient's (when it has one) so both numbers
  // come out the same math the headline uses. No inline division here.
  const ingredientMeasure =
    ingredient?.each_measure_qty != null && ingredient?.each_measure_uom
      ? { qty: Number(ingredient.each_measure_qty), uom: ingredient.each_measure_uom }
      : null;
  const itemFromItem = deriveRecipePrice({
    perBase: item.perBase,
    perBaseUom: item.perBaseUom,
    itemMeasure: item.eachMeasure,
    ingredientMeasure: null,
  });
  const itemFromIngredient = deriveRecipePrice({
    perBase: item.perBase,
    perBaseUom: item.perBaseUom,
    itemMeasure: null,
    ingredientMeasure,
  });

  return (
    <div className="kf-chain__row">
      <div className="kf-chain__label">Each measure</div>
      <div className="kf-chain__value">
        <label className="kf-dpn__toggle-label">
          <input
            type="checkbox"
            checked={hasOwn}
            onChange={(e) => onTickChange(e.currentTarget.checked)}
            disabled={busy}
          />
          <span>This item&rsquo;s each has its own measure</span>
        </label>
        {hasOwn ? (
          <div className="kf-dpn__row kf-newing__row">
            <label className="kf-dpn__label">
              <span>Qty</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                value={qtyDraft}
                onChange={(e) => setQtyDraft(e.target.value)}
                onBlur={trySave}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); trySave(); } }}
                placeholder="e.g. 6"
                aria-label="One each, quantity"
                disabled={busy}
              />
            </label>
            <label className="kf-dpn__label">
              <span>Unit</span>
              <select
                value={uomDraft}
                onChange={(e) => {
                  setUomDraft(e.target.value);
                  // Read current qty for the save decision (state will
                  // be updated by the time trySave runs on next tick).
                  queueMicrotask(trySave);
                }}
                disabled={busy}
                aria-label="One each, unit"
              >
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
            </label>
          </div>
        ) : null}
        <div className="kf-dpn__btns">
          <SaveFlash savedAt={savedAt} error={error} />
        </div>
        {itemFromItem ? (
          <span className="kf-chain__sub">
            {fmtUsd(item.perBase as number)} each ÷ {itemFromItem.qty} {uomLabel(itemFromItem.measureUom)} = {fmtUsd(itemFromItem.per)} / {uomLabel(itemFromItem.uom)}
            {itemFromIngredient ? (
              <>
                {" "}· the ingredient&rsquo;s {itemFromIngredient.qty} {uomLabel(itemFromIngredient.measureUom)} would give {fmtUsd(itemFromIngredient.per)} / {uomLabel(itemFromIngredient.uom)}.
              </>
            ) : null}
          </span>
        ) : itemFromIngredient && !hasOwn ? (
          <span className="kf-chain__sub">
            Without an item-level override, {fmtUsd(item.perBase as number)} each ÷ {itemFromIngredient.qty} {uomLabel(itemFromIngredient.measureUom)} = {fmtUsd(itemFromIngredient.per)} / {uomLabel(itemFromIngredient.uom)}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Direct per-base price override. Sits BELOW the pack chain on
// purpose - the pack is the cause, this is the symptom, and the
// ordering nudges toward fixing the cause. See
// setVendorItemPriceOverride for backfill-durability caveat.
// G1: the item's grade tier. Plainly a QUALITY classification, not a
// price field - held separately from the pack-chain + price-override
// blocks per the spec pin ("The control is plainly a quality tier,
// not a price field. Do not label it with a dollar sign or put it
// next to the price override."). Null is standard; 'premium' is the
// only sanctioned non-null value today. The write writes only
// pr_vendor_items.grade and emits one pr_events row with before AND
// after populated (the fix for the ledger-audit gap discovered
// 2026-11-04).
