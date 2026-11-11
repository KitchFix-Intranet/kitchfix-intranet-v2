"use client";

// N8 §1g: item-side each measure. Inline per render:
//   [ ] Different from the ingredient    (hint when unticked)
//   [x] Different from the ingredient    88px number  96px unit  Saved
//
// B5 rules unchanged from N7 commit 2:
//   (a) unit change saves when the number is valid;
//   (b) untick-saved clears immediately + Saved;
//   (c) untick-unsaved only hides fields;
//   (d) tick-no-number writes nothing until a valid number lands.
//
// deriveRecipePrice stays the single source for the derived figure;
// the panel never divides on its own. The render shows a short "Saved"
// marker rather than the full comparison paragraph - we keep the
// SaveFlash chip and drop the comparison paragraph per §1g.

import { useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";

export function ItemEachMeasureBlock({
  item,
  // ingredient reserved for future hints; not rendered inline per
  // render §1g (the derivation sentence moved to the ingredient zone).
  ingredient: _ingredient,
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
    if (!next && item.eachMeasure != null) void clearStored();
  }

  return (
    <div className="kf-ipanel__row-value-flex">
      <label style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "44px" }}>
        <input
          type="checkbox"
          checked={hasOwn}
          onChange={(e) => onTickChange(e.currentTarget.checked)}
          disabled={busy}
          style={{ width: "20px", height: "20px" }}
        />
        <span>Different from the ingredient</span>
      </label>
      {hasOwn ? (
        <>
          <input
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0"
            className="kf-ipanel__ctl kf-ipanel__ctl--qty"
            value={qtyDraft}
            onChange={(e) => setQtyDraft(e.target.value)}
            onBlur={trySave}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); trySave(); } }}
            placeholder="e.g. 5"
            aria-label="This item's each weighs"
            disabled={busy}
          />
          <select
            className="kf-ipanel__ctl kf-ipanel__ctl--uom"
            value={uomDraft}
            onChange={(e) => {
              setUomDraft(e.target.value);
              queueMicrotask(trySave);
            }}
            disabled={busy}
            aria-label="Weight unit for this item"
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
          <SaveFlash savedAt={savedAt} error={error} />
        </>
      ) : (
        <span className="kf-ipanel__row-hint">Tick if this case holds a different size</span>
      )}
    </div>
  );
}
