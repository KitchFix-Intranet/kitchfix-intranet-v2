"use client";

// Direct per-base price override. Sits BELOW the pack chain on
// purpose - the pack is the cause, this is the symptom, and the
// ordering nudges toward fixing the cause. See
// setVendorItemPriceOverride for backfill-durability caveat.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";
import { ingredientBaseUom } from "./packHelpers";

export function PriceOverrideBlock({
  item,
  ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const router = useRouter();
  // Default baseUom to the ingredient's base_unit when there is one,
  // else to the item's existing perBaseUom, else LB. All three are
  // valid first picks; LB is the dominant case.
  const ingBase = ingredientBaseUom(ingredient);
  const seedBaseUom =
    ingBase ??
    (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA"
      ? item.perBaseUom
      : "LB");

  // N7 B4 + commit 2: "the two editors gain Cancel". Baseline values
  // are captured once from the mount-time item snapshot and restored
  // by resetDrafts().
  const initialPerBaseStr = item.perBase != null ? Number(item.perBase).toFixed(4) : "";
  const [perBaseStr, setPerBaseStr] = useState<string>(initialPerBaseStr);
  // N6: the select widens to every weight / volume / EA unit. Stored
  // state is any of those strings; the route converts the typed value
  // to the dimension base before writing, so downstream still reads
  // { per_base in LB/FLOZ/EA }.
  const [baseUom, setBaseUom] = useState<string>(seedBaseUom);
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resetDrafts() {
    setPerBaseStr(initialPerBaseStr);
    setBaseUom(seedBaseUom);
    setReason("");
    setError(null);
  }
  const dirty =
    perBaseStr !== initialPerBaseStr ||
    baseUom !== seedBaseUom ||
    reason.trim().length > 0;

  const perBaseN = Number(perBaseStr);
  const perBaseValid = Number.isFinite(perBaseN) && perBaseN > 0;
  const reasonValid = reason.trim().length > 0;
  const readyToSave = perBaseValid && reasonValid;

  async function save() {
    if (busy || !readyToSave) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-price-override", {
      itemId: item.id,
      perBase: perBaseN,
      baseUom,
      reason: reason.trim(),
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    toast("Saved: price override");
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
    router.refresh();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Price override">
      <header className="kf-drawer__block-head">
        <h4>Price override</h4>
        <small>
          Use this when the pack is right and the number is not. Fixing the pack above corrects
          the cause; this one covers the symptom.
        </small>
      </header>

      <div className="kf-dpn__row kf-newing__row">
        <label className="kf-dpn__label">
          <span>$ per unit</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0"
            value={perBaseStr}
            onChange={(e) => setPerBaseStr(e.target.value)}
            placeholder="e.g. 0.73"
            disabled={busy}
          />
        </label>
        <label className="kf-dpn__label">
          <span>Unit</span>
          <select
            value={baseUom}
            onChange={(e) => setBaseUom(e.target.value)}
            disabled={busy}
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
            <option value="EA">each</option>
          </select>
        </label>
      </div>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Reason (required)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. vendor-confirmed, invoice pricing error"
            disabled={busy}
          />
        </label>
      </div>

      <div className="kf-dpn__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy || !readyToSave}
          onClick={save}
        >
          {busy ? "Saving..." : "Save price"}
        </button>
        <button
          type="button"
          className="kf-btn kf-btn--line kf-btn--sm"
          disabled={busy || !dirty}
          onClick={resetDrafts}
        >
          Cancel
        </button>
        <SaveFlash savedAt={savedAt} error={error} />
      </div>
    </section>
  );
}

// ===================================================================
// A3b: What needs attention + Evidence, around the Fix-this-item blocks
// ===================================================================
