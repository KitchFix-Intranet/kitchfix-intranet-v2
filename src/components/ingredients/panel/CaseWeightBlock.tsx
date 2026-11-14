"use client";

// M2 §4B §2.7: item-side Case weight override. Replaces
// ItemEachMeasureBlock. Rendered only when the pack is NOT a weight
// case (count or volume). Behind a quiet link "This case is a
// different size" at rest; open when a value is stored. Clear leaves
// the item back on the ingredient's measures.
//
// Writes through /api/review/set-case-weight.

import { useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtUsd } from "@/lib/fmt";
import { DIM_BY_UOM } from "@/lib/ingredients/pack";
import { priceInUnit } from "@/lib/ingredients/measures";
import type { ReviewGroupItem } from "../itemTypes";

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
  const storedCw = item.caseWeightLb ?? null;
  const [open, setOpen] = useState<boolean>(forceOpen || storedCw != null);
  const [val, setVal] = useState<string>(storedCw != null ? String(storedCw) : "");
  const [busy, setBusy] = useState(false);

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

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/review/set-case-weight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: item.id, caseWeightLb: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast(data.error ?? "Save failed");
        return;
      }
      toast("Case weight saved");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    try {
      const res = await fetch("/api/review/set-case-weight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: item.id, caseWeightLb: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast(data.error ?? "Clear failed");
        return;
      }
      setVal("");
      toast("Case weight cleared");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  return (
    <div className="kf-ipanel__row kf-ipanel__row--case-weight">
      <label className="kf-ipanel__row-label" htmlFor={`cw-${item.id}`}>
        <span>Case weighs</span>
      </label>
      <div className="kf-ipanel__row-value">
        <div className="kf-ipanel__row-value-flex">
          <input
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
            ? "caseWeightLb must be greater than 0 and at most 5000."
            : hint}
          {casePriceHint ? ` · ${casePriceHint}` : ""}
        </div>
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
      </div>
    </div>
  );
}
