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

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtUsd } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/measures";
import {
  IngredientAllergens,
  allergenStatus,
  type AllergensHandle,
  type AllergensState,
} from "../IngredientAllergens";
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

  // --- One each ---------------------------------------------------
  // N11 §2 R2: measure keeps its own baseline state and own sync
  // effect, split out of the shared rename/category sync below. A
  // refresh updates the baseline but never wipes a dirty draft on
  // the same ingredient.
  type MeasureShape = { qty: string; uom: string; source: string };
  const makeMeasure = (): MeasureShape => ({
    qty: ingredient.each_measure_qty == null ? "" : String(ingredient.each_measure_qty),
    uom: (ingredient.each_measure_uom ?? "").toUpperCase(),
    source: ingredient.each_measure_source ?? "house_test",
  });
  const equalMeasure = (a: MeasureShape, b: MeasureShape) =>
    a.qty === b.qty && a.uom === b.uom && a.source === b.source;

  const [measureBaseline, setMeasureBaseline] = useState<MeasureShape>(() => makeMeasure());
  const [measureDraft, setMeasureDraft] = useState<MeasureShape>(measureBaseline);
  const [measureBusy, setMeasureBusy] = useState(false);
  const [measureSavedAt, setMeasureSavedAt] = useState<number | null>(null);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const measurePrevIdRef = useRef(ingredient.id);
  const measurePriorStoredRef = useRef<MeasureShape>(measureBaseline);

  // Keep rename/category drafts in sync when the ingredient reloads
  // underneath. Measure fields are deliberately absent from this
  // effect per R2 (own effect below).
  useEffect(() => {
    setRenameDraft(ingredient.name);
    setSuperDraft(ingredient.category ?? "");
    setSubPick(ingredient.parent ?? "");
  }, [
    ingredient.id,
    ingredient.name,
    ingredient.category,
    ingredient.parent,
  ]);

  useEffect(() => {
    const next: MeasureShape = {
      qty: ingredient.each_measure_qty == null ? "" : String(ingredient.each_measure_qty),
      uom: (ingredient.each_measure_uom ?? "").toUpperCase(),
      source: ingredient.each_measure_source ?? "house_test",
    };
    const idChanged = measurePrevIdRef.current !== ingredient.id;
    const priorStored = measurePriorStoredRef.current;
    measurePrevIdRef.current = ingredient.id;
    measurePriorStoredRef.current = next;
    setMeasureBaseline(next);
    setMeasureDraft((cur) =>
      idChanged || equalMeasure(cur, priorStored) ? next : cur
    );
  }, [
    ingredient.id,
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

  // N11 §2: measure save goes through an explicit press now. The
  // qty-blur / unit-change auto-save and the blank-blur-clears
  // behaviour are both gone. Emptying the number is invalid (R3);
  // the Clear link below the row is the only way to remove.
  const measureDirty = !equalMeasure(measureDraft, measureBaseline);
  const measureQtyTrimmed = measureDraft.qty.trim();
  const measureQtyNum = Number(measureQtyTrimmed);
  const measureQtyValid =
    measureQtyTrimmed !== "" &&
    Number.isFinite(measureQtyNum) &&
    measureQtyNum > 0 &&
    measureQtyNum <= 100000;
  const measureUomDim = DIM_BY_UOM[measureDraft.uom];
  const measureUomValid = measureUomDim === "weight" || measureUomDim === "volume";
  const measureSaveEnabled =
    !measureBusy && measureDirty && measureQtyValid && measureUomValid;
  const measureHint =
    measureQtyTrimmed === "" ? "Enter a number"
    : measureQtyValid && !measureUomValid ? "Pick a unit"
    : null;

  async function doMeasureSave() {
    if (!measureSaveEnabled) return;
    setMeasureBusy(true);
    setMeasureError(null);
    const u = measureDraft.uom;
    const r = await postJson("/api/review/set-each-measure", {
      ingredientId: ingredient.id,
      qty: measureQtyNum,
      uom: u,
      source: measureDraft.source,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setMeasureError(msg);
      toast(msg, { tone: "block" });
      setMeasureBusy(false);
      return;
    }
    toast(`Saved: one each is ${Math.round(measureQtyNum * 10000) / 10000} ${uomLabel(u)}`);
    const saved: MeasureShape = {
      qty: String(measureQtyNum),
      uom: u,
      source: measureDraft.source,
    };
    measurePriorStoredRef.current = saved;
    setMeasureBaseline(saved);
    setMeasureDraft(saved);
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
    const cleared: MeasureShape = { qty: "", uom: "", source: measureDraft.source };
    measurePriorStoredRef.current = cleared;
    setMeasureBaseline(cleared);
    setMeasureDraft(cleared);
    setMeasureSavedAt(Date.now());
    setMeasureBusy(false);
    onDone();
  }

  function onMeasureDiscard() {
    if (measureBusy) return;
    setMeasureDraft(measureBaseline);
    setMeasureError(null);
  }

  function onMeasureKey(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" && measureSaveEnabled) {
      e.preventDefault();
      void doMeasureSave();
    } else if (e.key === "Escape" && measureDirty) {
      e.preventDefault();
      onMeasureDiscard();
    }
  }

  const renameDirty =
    renameDraft.trim().length >= 2 &&
    renameDraft.trim() !== ingredient.name;

  const allergenPill = allergenStatus(ingredient.allergens ?? [], ingredient.allergens_reviewed_at ?? null);

  // N12 round 2 fix 8: Confirm lives in the row's action column.
  // IngredientAllergens exposes its confirm() via a ref and reports
  // its state via onStateChange so the parent-rendered button mirrors
  // enablement + busy without owning the chip state.
  const allergenRef = useRef<AllergensHandle>(null);
  const [allergenCtl, setAllergenCtl] = useState<AllergensState>({
    canConfirm: ingredient.allergens_reviewed_at == null,
    busy: false,
    savedAt: null,
    error: null,
  });
  const onAllergenState = useCallback((s: AllergensState) => setAllergenCtl(s), []);

  // N8 round 3 fix 1: the ingredient's One each row describes the
  // INGREDIENT's own measure, so call deriveRecipePrice with
  // itemMeasure: null. The item's own measure (when it has one) wins
  // in the strip; here we append a short "This item uses its own
  // measure." clause so it is clear which number the engine will use.
  const measureFoot = (() => {
    const stored = ingredient.each_measure_qty;
    const draftN = Number(measureDraft.qty);
    const n = Number.isFinite(draftN) && draftN > 0 ? draftN : (stored != null ? Number(stored) : null);
    if (n == null) {
      return {
        tone: "warn" as const,
        label: "not set yet",
        body: "Enter what one each is, by weight or by volume, and recipes can cost it that way. The stored price stays per each.",
      };
    }
    const u = measureDraft.uom || (ingredient.each_measure_uom ?? "LB").toUpperCase();
    if (item && item.perBaseUom === "EA" && item.perBase != null) {
      const derivedFromIngredient = deriveRecipePrice({
        perBase: item.perBase,
        perBaseUom: item.perBaseUom,
        itemMeasure: null,
        ingredientMeasure: { qty: n, uom: u },
      });
      if (derivedFromIngredient) {
        const itemHasOwnMeasure = item.eachMeasure != null;
        const suffix = itemHasOwnMeasure ? " This item uses its own measure." : "";
        return {
          tone: "good" as const,
          label: "Saved",
          body:
            `Recipes will use ${fmtUsd(derivedFromIngredient.per)} / ${uomLabel(derivedFromIngredient.uom)} ` +
            `(${fmtUsd(item.perBase)} each ÷ ${derivedFromIngredient.qty} ${uomLabel(derivedFromIngredient.measureUom)}).` +
            ` The stored price stays per each.${suffix}`,
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
        <span className="kf-ipanel__zone-head-title">
          Ingredient
          <span className="kf-ipanel__zone-head-title-suffix"> &middot; {ingredient.name}</span>
        </span>
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

      {/* Row 2: Category - N8 round 3 fix 3 + 7: split 150/1fr/1fr
          grid; selects occupy cols 2 and 3 so the second ends flush
          with the row's right edge; sublink + flash sit in cat-foot
          spanning cols 2 to -1 underneath. Top-aligned via --cat. */}
      <div className="kf-ipanel__row kf-ipanel__row--split kf-ipanel__row--cat">
        <div className="kf-ipanel__row-label">
          <span>Category</span>
          {(!ingredient.category || !ingredient.parent) ? (
            <span className="kf-pill kf-pill--warn">Needs category</span>
          ) : null}
        </div>
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
        <div className="kf-ipanel__cat-foot">
          <button
            type="button"
            className="kf-ipanel__cat-link"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ add new sub-category" : "pick existing"}
          </button>
          <SaveFlash savedAt={catSavedAt} error={catError} />
        </div>
      </div>

      {/* Row 3: Costed per --------------------------------------- */}
      <div className="kf-ipanel__row kf-ipanel__row--split">
        <div className="kf-ipanel__row-label">Costed per</div>
        <BaseUnitControl
          row={{ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.base_unit }}
          onSaved={onDone}
        />
        <div className="kf-ipanel__row-hint">How recipes count this ingredient.</div>
      </div>

      {/* Row 4: One each is - N11 §2 R4: standard row shape (label /
          value / action). Value cell holds qty + unit + source; Save
          lives in the action column; the note row below carries
          saved-state, dirty "Not saved yet · Discard", and the
          immediate Clear link when a measure is stored. */}
      {ingredient.base_unit === "each" ? (
        <div className="kf-ipanel__row kf-ipanel__row--measure">
          <label className="kf-ipanel__row-label" htmlFor={`ing-m-qty-${ingredient.id}`}>
            One each is
          </label>
          <div className="kf-ipanel__row-value">
            <div className="kf-ipanel__row-value-flex">
              <input
                id={`ing-m-qty-${ingredient.id}`}
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                className="kf-ipanel__ctl kf-ipanel__ctl--qty"
                value={measureDraft.qty}
                onChange={(e) => {
                  const v = e.target.value;
                  setMeasureDraft((m) => ({ ...m, qty: v }));
                }}
                onKeyDown={onMeasureKey}
                placeholder=""
                aria-label="One each, quantity"
                disabled={measureBusy}
              />
              <select
                className="kf-ipanel__ctl kf-ipanel__ctl--uom"
                value={measureDraft.uom}
                onChange={(e) => {
                  const v = e.target.value.toUpperCase();
                  setMeasureDraft((m) => ({ ...m, uom: v }));
                }}
                onKeyDown={onMeasureKey}
                disabled={measureBusy}
                aria-label="One each, unit"
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
              <select
                className="kf-ipanel__ctl kf-ipanel__ctl--source"
                value={measureDraft.source}
                onChange={(e) => {
                  const v = e.target.value;
                  setMeasureDraft((m) => ({ ...m, source: v }));
                }}
                onKeyDown={onMeasureKey}
                disabled={measureBusy}
                aria-label="Where the measure came from"
              >
                <option value="house_test">Measured in house</option>
                <option value="book">Book value</option>
                <option value="vendor_spec">Vendor spec</option>
                <option value="estimate">Estimate</option>
              </select>
            </div>
            <div className="kf-ipanel__measure-note" aria-live="polite">
              {measureDirty ? (
                measureHint ? (
                  <>
                    <span>{measureHint}</span>
                    {ingredient.each_measure_qty != null ? (
                      <button
                        type="button"
                        className="kf-ipanel__measure-clear"
                        onClick={doMeasureClear}
                        disabled={measureBusy}
                      >
                        Clear
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span>Not saved yet</span>
                    <span aria-hidden>&middot;</span>
                    <button
                      type="button"
                      className="kf-ipanel__measure-discard"
                      onClick={onMeasureDiscard}
                      disabled={measureBusy}
                    >
                      Discard
                    </button>
                    {ingredient.each_measure_qty != null ? (
                      <button
                        type="button"
                        className="kf-ipanel__measure-clear"
                        onClick={doMeasureClear}
                        disabled={measureBusy}
                      >
                        Clear
                      </button>
                    ) : null}
                  </>
                )
              ) : (
                <>
                  {measureFoot.tone === "good" ? (
                    <span className="kf-pill kf-pill--good">Saved</span>
                  ) : (
                    <span className="kf-pill kf-pill--warn">not set yet</span>
                  )}
                  {ingredient.each_measure_qty != null ? (
                    <button
                      type="button"
                      className="kf-ipanel__measure-clear"
                      onClick={doMeasureClear}
                      disabled={measureBusy}
                    >
                      Clear
                    </button>
                  ) : null}
                  <span className="kf-ipanel__measure-body">{measureFoot.body}</span>
                </>
              )}
              <SaveFlash savedAt={measureSavedAt} error={measureError} />
            </div>
          </div>
          <div className="kf-ipanel__row-action">
            <button
              type="button"
              className={`kf-btn ${measureSaveEnabled ? "kf-btn--primary" : "kf-btn--line"} kf-btn--sm${measureBusy ? " is-busy" : ""}`}
              disabled={!measureSaveEnabled}
              onClick={doMeasureSave}
              onKeyDown={onMeasureKey}
            >
              {measureBusy ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Row 5: Allergens ---------------------------------------- */}
      <div className="kf-ipanel__row kf-ipanel__row--allergens">
        <div className="kf-ipanel__row-label">
          <span>Allergens</span>
          <span className={`kf-pill kf-pill--${allergenPill.tone}`}>{allergenPill.label}</span>
        </div>
        <div className="kf-ipanel__row-value">
          <IngredientAllergens
            ref={allergenRef}
            ingredientId={ingredient.id}
            allergens={ingredient.allergens}
            reviewedBy={ingredient.allergens_reviewed_by}
            reviewedAt={ingredient.allergens_reviewed_at}
            onSaved={onDone}
            onStateChange={onAllergenState}
          />
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className={`kf-btn ${allergenCtl.canConfirm ? "kf-btn--primary" : "kf-btn--line"} kf-btn--sm${allergenCtl.busy ? " is-busy" : ""}`}
            disabled={!allergenCtl.canConfirm || allergenCtl.busy}
            onClick={() => allergenRef.current?.confirm()}
          >
            {allergenCtl.busy ? "Saving..." : "Confirm"}
          </button>
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
          {/* N8 round 4 fix 1: one paragraph, one inline flow. The row
              value is a flex column by default; a block <p> inside
              owns the inline text so sibling <strong>s do not become
              their own flex items. */}
          <p className="kf-ipanel__pending-copy">
            The matcher proposed <strong>{proposedName ?? "a new ingredient"}</strong>
            {proposedParent ? <> under <strong>{proposedParent}</strong></> : null}.
            Hit &ldquo;New ingredient&rdquo; on the card below to create it (category required).
            Rename, category, resale, and merge become available once it exists.
          </p>
        </div>
        <div className="kf-ipanel__row-action" />
      </div>
    </section>
  );
}
