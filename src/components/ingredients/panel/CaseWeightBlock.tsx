"use client";

// M2 §4B §2.7: item-side Case weight override. Replaces
// ItemEachMeasureBlock. Rendered only when the pack is NOT a weight
// case (count or volume). Behind a quiet link "This case is a
// different size" at rest; open when a value is stored. Clear leaves
// the item back on the ingredient's measures.
//
// Writes through /api/review/set-case-weight.
//
// T4 §3: save + clear both route through the shared save-and-refresh
// helper so the Save button stays "Saving..." until the refreshed
// number has rendered; the success toast fires at that moment.

import { useEffect, useRef, useState } from "react";
import { fmtUsd } from "@/lib/fmt";
import { DIM_BY_UOM } from "@/lib/ingredients/pack";
import { priceInUnit } from "@/lib/ingredients/measures";
import type { ReviewGroupItem } from "../itemTypes";
import { postJson } from "./common";
import { useSaveWithRefresh } from "./useSaveWithRefresh";
import { SaveFlash } from "./SaveFlash";
import { useDirtyEditor } from "./dirty";

export function CaseWeightBlock({
  item,
  forceOpen = false,
  onDone,
}: {
  item: ReviewGroupItem;
  // §2.7: the row is open when case weight is stored OR the item is
  // left out of the blend as an outlier. Attention bubbles pass true.
  forceOpen?: boolean;
  onDone: () => void;
}) {
  // T3 §3b: after clear(), the API write lands and onDone triggers
  // a panel refetch (ItemPanelById bumps its nonce and GETs
  // /api/review/item). The fetch takes a round-trip to complete.
  // In the race window item.caseWeightLb is still the pre-clear
  // value because ItemPanelById deliberately keeps its state.data
  // visible during the refetch (no "Loading..." flash). `localCw`
  // is the optimistic view: it mirrors the stored value at rest,
  // and is set to null the moment clear() succeeds so the Clear
  // button and hint flip immediately. The useEffect snaps localCw
  // back to the server value once the refetch resolves.
  const serverCw = item.caseWeightLb ?? null;
  const [localCw, setLocalCw] = useState<number | null>(serverCw);
  useEffect(() => { setLocalCw(serverCw); }, [serverCw]);
  const storedCw = localCw;
  const [open, setOpen] = useState<boolean>(forceOpen || storedCw != null);
  const [val, setVal] = useState<string>(storedCw != null ? String(storedCw) : "");
  const { save: runSave, busy, savedAt, error } = useSaveWithRefresh();

  // Not shown at all for a weight case (pack_uom is weight). Those
  // items price per the pack's own weight; no override needed.
  const pu = (item.packUom ?? "").toUpperCase();
  const isWeightCase = DIM_BY_UOM[pu] === "weight";
  if (isWeightCase) return null;

  if (!open) {
    return (
      <div className="kf-ipanel__row kf-ipanel__row--case-weight-closed">
        <div className="kf-ipanel__row-label" />
        <div className="kf-ipanel__row-value">
          <button
            type="button"
            className="kf-ipanel__link"
            onClick={() => setOpen(true)}
          >
            This case is a different size
          </button>
        </div>
        <div className="kf-ipanel__row-action" />
      </div>
    );
  }

  const n = val.trim() ? Number(val) : null;
  const valid = n == null || (Number.isFinite(n) && n > 0 && n <= 5000);
  const dirty = (storedCw ?? null) !== (n ?? null);
  // T2 §3: the panel's Discard ask asks us to reset to what the server
  // stored; that is storedCw -> the input's string form.
  useDirtyEditor(
    `case-weight-${item.id}`,
    dirty && !busy,
    () => setVal(storedCw != null ? String(storedCw) : "")
  );

  async function save() {
    // T4 §3 wrapper keeps the Save button in "Saving..." until the
    // refreshed data has rendered + the toast fires at that moment.
    // T3 §3b optimistic flip rides INSIDE onAfterSuccess so the hint
    // and Clear-button visibility move the instant the POST returns
    // 200 - ItemPanelById's own nonce refetch still lags the strip
    // header a tick, which is a race T4's useTransition does not
    // close.
    await runSave({
      op: () => postJson("/api/review/set-case-weight", { itemId: item.id, caseWeightLb: n }),
      successMessage: "Case weight saved",
      errorFallback: "Save failed",
      onAfterSuccess: () => { if (n != null) setLocalCw(n); },
      onDone,
    });
  }
  async function clear() {
    const r = await runSave({
      op: () => postJson("/api/review/set-case-weight", { itemId: item.id, caseWeightLb: null }),
      successMessage: "Case weight cleared",
      errorFallback: "Clear failed",
      // T3 §3b: flip "no case weight" immediately on success so the
      // hint reads "Leave empty to use the ingredient's measures."
      // and the Clear button disappears before the refetch resolves.
      onAfterSuccess: () => setLocalCw(null),
      onDone,
    });
    if (r.ok) setVal("");
  }

  const hint =
    storedCw != null && Number.isFinite(storedCw)
      ? "This case uses its own weight."
      : "Leave empty to use the ingredient's measures.";
  // T1 R2-2: ask the library for the per-lb number through the case
  // weight the block is currently showing. priceInUnit returns the
  // whole-case-weighs-X route when the case weight supplies the
  // weight total; we print only when that route fires + viaCaseWeight
  // is true. Fixes two ways the old line was wrong on 1b9ffe6:
  //   1. item.perBaseInIngUnit is in the ingredient's unit, not lb.
  //      For each-costed ingredients (Egg rolls, Tomatoes round) it
  //      printed the per-each price beside a hard-coded "/ lb".
  //   2. Any ingredient with no measures routed to kind="fallback",
  //      which ignores case weight; the line had no business firing.
  const liveCwHint: string | null = (() => {
    const cw = storedCw;
    if (cw == null || !Number.isFinite(cw) || cw <= 0) return null;
    if (item.perBase == null || item.perBaseUom == null) return null;
    const r = priceInUnit(
      {
        perBase: item.perBase,
        baseUom: item.perBaseUom,
        packQty: item.packQty,
        packSize: item.packSize,
        packUom: item.packUom,
        caseWeightLb: cw,
      },
      "LB",
      { measures: [] },
    );
    if (r == null) return null;
    if (r.route.kind !== "stated" || !r.route.viaCaseWeight) return null;
    return `${fmtUsd(r.per)} / lb at ${cw} lb`;
  })();
  const casePriceHint = liveCwHint;

  // T6 round 2 item 1 + round 3 small 1-2: autofocus the weight
  // input with its value selected; capture last-focused element
  // before the ask opens so Keep editing returns there.
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFieldRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      try { inputRef.current?.select(); } catch { /* noop */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const [askOpen, setAskOpen] = useState(false);
  function tryCloseRow() {
    if (busy) return;
    if (dirty) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) lastFieldRef.current = active;
      setAskOpen(true);
      return;
    }
    setOpen(false);
    setVal(storedCw != null ? String(storedCw) : "");
  }
  function keepEditing() {
    setAskOpen(false);
    window.setTimeout(() => { lastFieldRef.current?.focus(); }, 0);
  }
  function discardAndClose() {
    setVal(storedCw != null ? String(storedCw) : "");
    setAskOpen(false);
    setOpen(false);
  }
  return (
    <div
      className="kf-ipanel__row kf-ipanel__row--case-weight"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          tryCloseRow();
        }
      }}
    >
      <label className="kf-ipanel__row-label" htmlFor={`cw-${item.id}`}>
        <span>Case weighs</span>
      </label>
      <div className="kf-ipanel__row-value">
        <div className="kf-ipanel__row-value-flex">
          <input
            ref={inputRef}
            id={`cw-${item.id}`}
            type="number"
            inputMode="decimal"
            className="kf-ipanel__ctl kf-ipanel__ctl--qty"
            min="0"
            max="5000"
            step="0.001"
            value={val}
            onChange={(e) => setVal(e.currentTarget.value)}
            placeholder=""
            disabled={busy}
            aria-label="Case weight in pounds"
          />
          <span>lb</span>
        </div>
        <div className="kf-ipanel__row-hint">
          {!valid
            ? "Enter a weight in lb greater than 0."
            : hint}
          {casePriceHint ? ` · ${casePriceHint}` : ""}
        </div>
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
      </div>
      <div className="kf-ipanel__row-action">
        <button
          type="button"
          className="kf-btn kf-btn--primary kf-btn--sm"
          disabled={!dirty || !valid || busy}
          onClick={save}
        >
          {busy ? "Saving..." : "Save"}
        </button>
        {storedCw != null ? (
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={clear}
            disabled={busy}
          >
            Clear
          </button>
        ) : null}
        <SaveFlash savedAt={savedAt} error={error} />
      </div>
    </div>
  );
}
