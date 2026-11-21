"use client";

// Direct per-base price override. Sits BELOW the pack chain on
// purpose - the pack is the cause, this is the symptom, and the
// ordering nudges toward fixing the cause. See
// setVendorItemPriceOverride for backfill-durability caveat.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useEffect, useRef, useState } from "react";
import { WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson } from "./common";
import { useDirtyEditor } from "./dirty";
import { ingredientBaseUom } from "./packHelpers";
import { useSaveWithRefresh } from "./useSaveWithRefresh";

export function PriceOverrideBlock({
  item,
  ingredient,
  onDone,
  onCancel,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
  // N8 §1f: Cancel closes the row when the caller is a panel row.
  onCancel?: () => void;
}) {
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
  // T4 §3: busy + savedAt + error all come from the shared hook; it
  // keeps busy=true until the refresh has rendered so the Save primary
  // reads "Saving..." while the new number is still mid-flight.
  const { save: runSave, busy, savedAt, error, clearError } = useSaveWithRefresh();

  function resetDrafts() {
    setPerBaseStr(initialPerBaseStr);
    setBaseUom(seedBaseUom);
    setReason("");
    clearError();
  }
  const dirty =
    perBaseStr !== initialPerBaseStr ||
    baseUom !== seedBaseUom ||
    reason.trim().length > 0;
  // T2 §3: panel Discard ask -> resetDrafts().
  useDirtyEditor(`price-override-${item.id}`, dirty && !busy, resetDrafts);

  const perBaseN = Number(perBaseStr);
  const perBaseValid = Number.isFinite(perBaseN) && perBaseN > 0;
  const reasonValid = reason.trim().length > 0;
  const readyToSave = perBaseValid && reasonValid;

  async function save() {
    if (busy || !readyToSave) return;
    await runSave({
      op: () =>
        postJson("/api/review/set-price-override", {
          itemId: item.id,
          perBase: perBaseN,
          baseUom,
          reason: reason.trim(),
        }),
      successMessage: "Saved: price override",
      onDone,
    });
  }

  // T6 round 2 item 1 + round 3 small 1-2: autofocus first field
  // with its value selected; capture last-focused field before the
  // ask opens so Keep editing returns focus there.
  const priceRef = useRef<HTMLInputElement>(null);
  const lastFieldRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    priceRef.current?.focus();
    try { priceRef.current?.select(); } catch { /* noop */ }
  }, []);
  const [askOpen, setAskOpen] = useState(false);
  function tryClose() {
    if (busy) return;
    if (dirty) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) lastFieldRef.current = active;
      setAskOpen(true);
      return;
    }
    if (onCancel) onCancel();
  }
  function keepEditing() {
    setAskOpen(false);
    window.setTimeout(() => { lastFieldRef.current?.focus(); }, 0);
  }
  function discardAndClose() {
    resetDrafts();
    setAskOpen(false);
    if (onCancel) onCancel();
  }

  return (
    <form
      className="kf-ipanel__editor"
      aria-label="Price by hand editor"
      noValidate
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          tryClose();
        }
      }}
    >
      <div className="kf-ipanel__editor-grid kf-ipanel__editor-grid--2">
        <label className="kf-ipanel__editor-field">
          Price per unit
          <input
            ref={priceRef}
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0"
            className="kf-ipanel__ctl"
            value={perBaseStr}
            onChange={(e) => setPerBaseStr(e.target.value)}
            placeholder="e.g. 0.73"
            disabled={busy}
          />
        </label>
        <label className="kf-ipanel__editor-field">
          Unit
          <select
            className="kf-ipanel__ctl"
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

      <label className="kf-ipanel__editor-field">
        Why <small>so the next person knows</small>
        <input
          type="text"
          className="kf-ipanel__ctl"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. vendor-confirmed, invoice pricing error"
          disabled={busy}
        />
      </label>

      {askOpen ? (
        <div className="kf-ipanel__editor-ask" role="alertdialog" aria-label="Discard what you typed?">
          <span className="kf-ipanel__editor-ask-text">Discard what you typed?</span>
          <button
            type="button"
            className="kf-btn kf-btn--primary kf-btn--sm"
            autoFocus
            onClick={keepEditing}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={discardAndClose}
          >
            Discard
          </button>
        </div>
      ) : null}

      <div className="kf-ipanel__editor-actions">
        <button
          type="button"
          className="kf-btn kf-btn--ghost kf-btn--sm"
          disabled={busy}
          onClick={tryClose}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy || !readyToSave}
        >
          {busy ? "Saving..." : "Save price"}
        </button>
        <SaveFlash savedAt={savedAt} error={error} />
      </div>
    </form>
  );
}

// ===================================================================
// A3b: What needs attention + Evidence, around the Fix-this-item blocks
// ===================================================================
