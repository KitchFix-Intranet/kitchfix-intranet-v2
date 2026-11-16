"use client";

// M2 §4B §2.5: Usable after prep. Decimal-tolerant (87.5 OK). Range
// > 0 and <= 100 (DB-enforced via pr_ingredients_yield_range). Source
// select is the 4-value yield vocab (no "pack"). Clearing saves null
// for both fields. Yield changes NO price anywhere in M2.

import { useState } from "react";
import { toast } from "@/components/ui/Toaster";
import type { ReviewCardIngredient } from "../itemTypes";

const YIELD_SOURCES = [
  { v: "house_test", label: "house test" },
  { v: "book", label: "book value" },
  { v: "vendor_spec", label: "vendor spec" },
  { v: "estimate", label: "estimate" },
] as const;

export function PanelYieldRow({
  ingredient,
  yieldPct,
  yieldSource,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  yieldPct: number | null;
  yieldSource: string | null;
  onDone: () => void;
}) {
  const [qtyStr, setQtyStr] = useState<string>(yieldPct != null ? String(yieldPct) : "");
  const [source, setSource] = useState<string>(yieldSource ?? "estimate");
  const [busy, setBusy] = useState(false);

  const trimmed = qtyStr.trim();
  const n = trimmed ? Number(trimmed) : null;
  const valid = n == null || (Number.isFinite(n) && n > 0 && n <= 100);
  const dirty = (yieldPct ?? null) !== (n ?? null) || (yieldSource ?? "estimate") !== source;

  const echo = (() => {
    if (n == null) return "Nothing is lost in prep";
    if (n >= 100) return "Nothing is lost in prep";
    return `1 lb bought gives ${(n / 100).toFixed(2)} lb prepped`;
  })();

  async function save(toClear: boolean) {
    setBusy(true);
    try {
      const body = toClear
        ? { ingredientId: ingredient.id, yieldPct: null, yieldSource: null }
        : { ingredientId: ingredient.id, yieldPct: n, yieldSource: source };
      const res = await fetch("/api/review/set-ingredient-yield", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast(data.error ?? "Save failed");
        return;
      }
      // T3 §3c: the local qtyStr / source held the pre-save values,
      // so after a clear the box still read 95 and Save stayed live
      // (dirty = pre-save qty !== n = null, i.e. 95 !== null). Reset
      // the draft to the state that just landed on the server so the
      // row's Save button goes back to its rest state. Clearing wipes
      // the number and reverts the source dropdown to the default
      // ("estimate"), matching the fresh-mount read of the API
      // response.
      if (toClear) {
        setQtyStr("");
        setSource("estimate");
      } else if (n != null) {
        setQtyStr(String(n));
      }
      toast(toClear ? "Yield cleared" : "Yield saved");
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kf-ipanel__row kf-ipanel__row--yield">
      <label className="kf-ipanel__row-label" htmlFor={`ing-y-${ingredient.id}`}>
        <span>Usable after prep</span>
        <span className="kf-ipanel__row-hint">
          What is left after trimming and prep. It never changes what you paid.
        </span>
      </label>
      <div className="kf-ipanel__row-value">
        <div className="kf-ipanel__row-value-flex">
          <input
            id={`ing-y-${ingredient.id}`}
            type="number"
            inputMode="decimal"
            className="kf-ipanel__ctl kf-ipanel__ctl--qty"
            min="0"
            max="100"
            step="0.1"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.currentTarget.value)}
            placeholder=""
            aria-label="Usable percent after prep"
            disabled={busy}
          />
          <span>%</span>
          <select
            className="kf-ipanel__ctl kf-ipanel__ctl--source"
            value={source}
            onChange={(e) => setSource(e.currentTarget.value)}
            aria-label="Yield source"
            disabled={busy}
          >
            {YIELD_SOURCES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="kf-ipanel__row-hint">
          {!valid
            ? "Enter a number greater than 0 and at most 100."
            : echo}
        </div>
      </div>
      <div className="kf-ipanel__row-action">
        <button
          type="button"
          className="kf-btn kf-btn--primary kf-btn--sm"
          disabled={!dirty || !valid || !trimmed || busy}
          onClick={() => save(false)}
        >
          {busy ? "Saving..." : "Save"}
        </button>
        {yieldPct != null ? (
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            disabled={busy}
            onClick={() => save(true)}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
