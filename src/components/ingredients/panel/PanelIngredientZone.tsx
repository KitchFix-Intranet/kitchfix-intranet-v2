"use client";

// N8 §3e: INGREDIENT zone on sky-soft, full width. Five rows in the
// row primitive per the render:
//   1. Name       (full-width input + Rename button; outline at rest,
//                  primary while the draft differs)
//   2. Category   (two selects filling the value; empty action column;
//                  "+ add new sub-category" is a text sublink, not a
//                  44 px button)
//   3. Costed per (bare BaseUnitControl + muted hint right)
//   4. One each is (qty 88 + unit 96, source fills; Saved / not set
//                  pill + derivation sentence underneath; NO Clear
//                  button - blanking the number clears)
//   5. Allergens  (label + status pill in label column; chips +
//                  Confirm button in the value column)
//
// Pending (ai-new) renders as the same zone shape.

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtUsd } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/eachMeasure";
import { IngredientAllergens, allergenStatus } from "../IngredientAllergens";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";
import { BaseUnitControl } from "./BaseUnitControl";

export function PanelIngredientZone({
  ingredient,
  // N8 fix 3: item in scope -> measure note states the derived price
  // for THIS item; ingredient-only mode -> generic sentence.
  item,
  parentOptions,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  item: ReviewGroupItem | null;
  parentOptions: string[];
  onDone: () => void;
}) {
  // --- Rename ----------------------------------------------------
  const [renameDraft, setRenameDraft] = useState(ingredient.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameSavedAt, setRenameSavedAt] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  // --- Category --------------------------------------------------
  const [superDraft, setSuperDraft] = useState<string>(ingredient.category ?? "");
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(ingredient.parent ?? "");
  const [subNew, setSubNew] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [catSavedAt, setCatSavedAt] = useState<number | null>(null);
  const [catError, setCatError] = useState<string | null>(null);

  // --- One each --------------------------------------------------
  const [measureQtyDraft, setMeasureQtyDraft] = useState<string>(
    ingredient.each_measure_qty == null ? "" : String(ingredient.each_measure_qty)
  );
  const [measureUomDraft, setMeasureUomDraft] = useState<string>(
    (ingredient.each_measure_uom ?? "LB").toUpperCase()
  );
  const [measureSourceDraft, setMeasureSourceDraft] = useState<string>(
    ingredient.each_measure_source ?? "house_test"
  );
  const [measureBusy, setMeasureBusy] = useState(false);
  const [measureSavedAt, setMeasureSavedAt] = useState<number | null>(null);
  const [measureError, setMeasureError] = useState<string | null>(null);

  // Keep local drafts in sync when the ingredient reloads underneath.
  useEffect(() => {
    setRenameDraft(ingredient.name);
    setSuperDraft(ingredient.category ?? "");
    setSubPick(ingredient.parent ?? "");
    setMeasureQtyDraft(
      ingredient.each_measure_qty == null ? "" : String(ingredient.each_measure_qty)
    );
    setMeasureUomDraft((ingredient.each_measure_uom ?? "LB").toUpperCase());
    setMeasureSourceDraft(ingredient.each_measure_source ?? "house_test");
  }, [
    ingredient.id,
    ingredient.name,
    ingredient.category,
    ingredient.parent,
    ingredient.each_measure_qty,
    ingredient.each_measure_uom,
    ingredient.each_measure_source,
  ]);

  async function doRename() {
    const next = renameDraft.trim();
    if (renameBusy) return;
    if (next.length < 2) { toast("Name is too short", { tone: "block" }); return; }
    if (next === ingredient.name) { toast("Same name, nothing to save"); return; }
    setRenameBusy(true);
    setRenameError(null);
    const r = await postJson("/api/review/rename-ingredient", {
      ingredientId: ingredient.id,
      newName: next,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Rename failed (${r.status})`);
      setRenameError(msg);
      toast(msg, { tone: "block" });
      setRenameBusy(false);
      return;
    }
    const d = r.data as { aliasWritten?: boolean };
    toast(
      d.aliasWritten
        ? `Saved - old name kept as an alias so links survive`
        : `Saved: name`
    );
    setRenameSavedAt(Date.now());
    setRenameBusy(false);
    onDone();
  }

  async function doCategory(opts: {
    nextSuper: SuperCategory | null;
    nextSub: string | null;
  }) {
    if (catBusy) return;
    const current: SuperCategory | null = (ingredient.category as SuperCategory | null) ?? null;
    const currentSub = ingredient.parent ?? null;
    if (opts.nextSuper === current && opts.nextSub === currentSub) return;
    setCatBusy(true);
    setCatError(null);
    const r = await postJson("/api/review/set-category", {
      ingredientId: ingredient.id,
      category: opts.nextSuper,
      parent: opts.nextSub,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setCatError(msg);
      toast(msg, { tone: "block" });
      setSuperDraft(ingredient.category ?? "");
      setSubPick(ingredient.parent ?? "");
      setSubNew("");
      setCatBusy(false);
      return;
    }
    toast(opts.nextSuper ? `Saved: category ${opts.nextSuper}` : "Saved: Needs category");
    setCatSavedAt(Date.now());
    setCatBusy(false);
    onDone();
  }

  async function doMeasureSave() {
    if (measureBusy) return;
    const trimmed = measureQtyDraft.trim();
    if (trimmed === "") return;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return;
    const u = measureUomDraft.toUpperCase();
    const dim = DIM_BY_UOM[u];
    if (dim !== "weight" && dim !== "volume") return;
    if (
      ingredient.each_measure_qty != null &&
      Number(ingredient.each_measure_qty) === n &&
      (ingredient.each_measure_uom ?? "").toUpperCase() === u &&
      (ingredient.each_measure_source ?? "house_test") === measureSourceDraft
    ) {
      return;
    }
    setMeasureBusy(true);
    setMeasureError(null);
    const r = await postJson("/api/review/set-each-measure", {
      ingredientId: ingredient.id,
      qty: n,
      uom: u,
      source: measureSourceDraft,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setMeasureError(msg);
      toast(msg, { tone: "block" });
      setMeasureBusy(false);
      return;
    }
    toast(`Saved: one each is ${Math.round(n * 10000) / 10000} ${uomLabel(u)}`);
    setMeasureSavedAt(Date.now());
    setMeasureBusy(false);
    onDone();
  }

  async function doMeasureClear() {
    if (measureBusy) return;
    if (ingredient.each_measure_qty == null) return;
    setMeasureBusy(true);
    setMeasureError(null);
    const r = await postJson("/api/review/set-each-measure", {
      ingredientId: ingredient.id,
      qty: null,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Clear failed (${r.status})`);
      setMeasureError(msg);
      toast(msg, { tone: "block" });
      setMeasureBusy(false);
      return;
    }
    toast("Measure cleared");
    setMeasureQtyDraft("");
    setMeasureSavedAt(Date.now());
    setMeasureBusy(false);
    onDone();
  }

  // N8 §1g: "clearing the number and leaving the field clears the
  // measure." Blank blur == clear if there was a stored value.
  function onMeasureQtyBlur() {
    const trimmed = measureQtyDraft.trim();
    if (trimmed === "" && ingredient.each_measure_qty != null) {
      void doMeasureClear();
      return;
    }
    void doMeasureSave();
  }

  const renameDirty =
    renameDraft.trim().length >= 2 &&
    renameDraft.trim() !== ingredient.name;

  const allergenState = allergenStatus(ingredient.allergens ?? [], ingredient.allergens_reviewed_at ?? null);

  // Measure note under One each. N8 fix 3: when an item is in scope
  // and a measure is present, state the derived price explicitly
  // ("Recipes will use $0.91 / lb for this item ($3.18 each ÷ 3.5 lb).
  // The stored price stays per each."). Ingredient-only mode keeps the
  // generic sentence.
  const measureFoot = (() => {
    const stored = ingredient.each_measure_qty;
    const draftN = Number(measureQtyDraft);
    const n = Number.isFinite(draftN) && draftN > 0 ? draftN : (stored != null ? Number(stored) : null);
    if (n == null) {
      return {
        tone: "warn" as const,
        label: "not set yet",
        body: "Enter what one each is, by weight or by volume, and recipes can cost it that way. The stored price stays per each.",
      };
    }
    const u = measureUomDraft.toUpperCase();
    if (item && item.perBaseUom === "EA" && item.perBase != null) {
      const derived = deriveRecipePrice({
        perBase: item.perBase,
        perBaseUom: item.perBaseUom,
        itemMeasure: item.eachMeasure,
        ingredientMeasure: { qty: n, uom: u },
      });
      if (derived) {
        return {
          tone: "good" as const,
          label: "Saved",
          body: `Recipes will use ${fmtUsd(derived.per)} / ${uomLabel(derived.uom)} for this item (${fmtUsd(item.perBase)} each ÷ ${derived.qty} ${uomLabel(derived.measureUom)}). The stored price stays per each.`,
        };
      }
    }
    return {
      tone: "good" as const,
      label: "Saved",
      body: `Recipes will use this measure to cost in ${uomLabel(u)}. The stored price stays per each.`,
    };
  })();

  return (
    <section className="kf-ipanel__zone kf-ipanel__zone--ing" aria-label="Ingredient">
      <header className="kf-ipanel__zone-head">
        <span className="kf-ipanel__zone-head-title">Ingredient &middot; {ingredient.name}</span>
        <span className="kf-ipanel__zone-head-sub">Changes here apply to every item linked to it</span>
      </header>

      {/* Row 1: Name ---------------------------------------------- */}
      <div className="kf-ipanel__row">
        <label className="kf-ipanel__row-label" htmlFor={`ing-name-${ingredient.id}`}>
          Name
        </label>
        <div className="kf-ipanel__row-value">
          <input
            id={`ing-name-${ingredient.id}`}
            type="text"
            className="kf-ipanel__ctl"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void doRename(); } }}
            placeholder="Ingredient name"
            disabled={renameBusy}
          />
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className={`kf-btn ${renameDirty ? "kf-btn--primary" : "kf-btn--line"} kf-btn--sm${renameBusy ? " is-busy" : ""}`}
            disabled={renameBusy || !renameDirty}
            onClick={doRename}
          >
            {renameBusy ? "Saving..." : "Rename"}
          </button>
          <SaveFlash savedAt={renameSavedAt} error={renameError} />
        </div>
      </div>

      {/* Row 2: Category - N8 fix 5: sublink inside the value column
          under the selects. Action column stays empty. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Category</span>
          {(!ingredient.category || !ingredient.parent) ? (
            <span className="kf-pill kf-pill--warn">Needs category</span>
          ) : null}
        </div>
        <div className="kf-ipanel__row-value">
          <div className="kf-ipanel__cat-selects">
            <select
              className="kf-ipanel__ctl"
              value={superDraft}
              disabled={catBusy}
              onChange={(e) => {
                const v = e.target.value;
                setSuperDraft(v);
                const nextSub =
                  subMode === "new" ? subNew.trim() || null : (subPick === "" ? null : subPick);
                void doCategory({
                  nextSuper: v === "" ? null : (v as SuperCategory),
                  nextSub,
                });
              }}
              aria-label="Category"
            >
              <option value="">Needs category</option>
              {SUPER_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {subMode === "pick" ? (
              <select
                className="kf-ipanel__ctl"
                value={subPick}
                disabled={catBusy}
                onChange={(e) => {
                  const v = e.target.value;
                  setSubPick(v);
                  void doCategory({
                    nextSuper: superDraft === "" ? null : (superDraft as SuperCategory),
                    nextSub: v === "" ? null : v,
                  });
                }}
                aria-label="Sub-category"
              >
                <option value="">(none)</option>
                {parentOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            ) : (
              <input
                className="kf-ipanel__ctl"
                type="text"
                value={subNew}
                onChange={(e) => setSubNew(e.target.value)}
                onBlur={() => {
                  const next = subNew.trim();
                  if (!next) return;
                  void doCategory({
                    nextSuper: superDraft === "" ? null : (superDraft as SuperCategory),
                    nextSub: next,
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const next = subNew.trim();
                    if (!next) return;
                    void doCategory({
                      nextSuper: superDraft === "" ? null : (superDraft as SuperCategory),
                      nextSub: next,
                    });
                  }
                }}
                placeholder="New sub-category"
                disabled={catBusy}
                aria-label="New sub-category"
                autoFocus
              />
            )}
          </div>
          <button
            type="button"
            className="kf-ipanel__cat-link"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ add new sub-category" : "pick existing"}
          </button>
          <SaveFlash savedAt={catSavedAt} error={catError} />
        </div>
        <div className="kf-ipanel__row-action" />
      </div>

      {/* Row 3: Costed per --------------------------------------- */}
      <div className="kf-ipanel__row kf-ipanel__row--split">
        <div className="kf-ipanel__row-label">Costed per</div>
        <BaseUnitControl
          row={{ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.base_unit }}
          onSaved={onDone}
          chrome="bare"
        />
        <div className="kf-ipanel__row-hint">How recipes count this ingredient.</div>
      </div>

      {/* Row 4: One each is - controls on line 1, measure note on
          line 2 inside the same grid (spans cols 2 to -1). */}
      {ingredient.base_unit === "each" ? (
        <div className="kf-ipanel__row kf-ipanel__row--split">
          <label className="kf-ipanel__row-label" htmlFor={`ing-m-qty-${ingredient.id}`}>
            One each is
          </label>
          <div className="kf-ipanel__row-value-flex">
            <input
              id={`ing-m-qty-${ingredient.id}`}
              type="number"
              inputMode="decimal"
              step="0.0001"
              min="0"
              className="kf-ipanel__ctl kf-ipanel__ctl--qty"
              value={measureQtyDraft}
              onChange={(e) => setMeasureQtyDraft(e.target.value)}
              onBlur={onMeasureQtyBlur}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onMeasureQtyBlur(); } }}
              placeholder="e.g. 6"
              aria-label="One each, quantity"
              disabled={measureBusy}
            />
            <select
              className="kf-ipanel__ctl kf-ipanel__ctl--uom"
              value={measureUomDraft}
              onChange={(e) => {
                const u = e.target.value;
                setMeasureUomDraft(u);
                const trimmed = measureQtyDraft.trim();
                if (trimmed === "") return;
                const n = Number(trimmed);
                if (!Number.isFinite(n) || n <= 0 || n > 100000) return;
                void doMeasureSave();
              }}
              disabled={measureBusy}
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
          </div>
          <select
            className="kf-ipanel__ctl"
            value={measureSourceDraft}
            onChange={(e) => setMeasureSourceDraft(e.target.value)}
            disabled={measureBusy}
            aria-label="Where the measure came from"
          >
            <option value="house_test">Measured in house</option>
            <option value="book">Book value</option>
            <option value="vendor_spec">Vendor spec</option>
            <option value="estimate">Estimate</option>
          </select>
          <div className="kf-ipanel__measure-note" aria-live="polite">
            {measureFoot.tone === "good" ? (
              <span className="kf-pill kf-pill--good">Saved</span>
            ) : (
              <span className="kf-pill kf-pill--warn">not set yet</span>
            )}
            <span>{measureFoot.body}</span>
            <SaveFlash savedAt={measureSavedAt} error={measureError} />
          </div>
        </div>
      ) : null}

      {/* Row 5: Allergens ---------------------------------------- */}
      <div className="kf-ipanel__row kf-ipanel__row--allergens">
        <div className="kf-ipanel__row-label">
          <span>Allergens</span>
          <span className={`kf-pill kf-pill--${allergenState.tone}`}>{allergenState.label}</span>
        </div>
        <div className="kf-ipanel__row-value">
          <IngredientAllergens
            ingredientId={ingredient.id}
            allergens={ingredient.allergens}
            reviewedBy={ingredient.allergens_reviewed_by}
            reviewedAt={ingredient.allergens_reviewed_at}
            onSaved={onDone}
            chrome="bare"
          />
        </div>
      </div>
    </section>
  );
}

export function PanelIngredientZonePending({
  proposedName,
  proposedParent,
}: {
  proposedName: string | null;
  proposedParent: string | null;
}) {
  return (
    <section className="kf-ipanel__zone kf-ipanel__zone--ing" aria-label="Ingredient not yet created">
      <header className="kf-ipanel__zone-head">
        <span className="kf-ipanel__zone-head-title">Ingredient &middot; not yet created</span>
        <span className="kf-ipanel__zone-head-sub">finish the create flow to edit</span>
      </header>
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">Proposed</div>
        <div className="kf-ipanel__row-value">
          The matcher proposed <strong>{proposedName ?? "a new ingredient"}</strong>
          {proposedParent ? <> under <strong>{proposedParent}</strong></> : null}.
          Hit &ldquo;New ingredient&rdquo; on the card below to create it (category required).
          Rename, category, resale, and merge become available once it exists.
        </div>
        <div className="kf-ipanel__row-action" />
      </div>
    </section>
  );
}
