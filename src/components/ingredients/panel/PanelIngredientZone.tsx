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
// M2 §4B amendment 4: no screen imports deriveRecipePrice. The
// measureFoot sentence below reads item.perBaseInIngUnit (set by
// the server via priceInUnit) instead of re-deriving in the client.
import {
  IngredientAllergens,
  allergenStatus,
  type AllergensHandle,
  type AllergensState,
} from "../IngredientAllergens";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson } from "./common";
import { BaseUnitControl } from "./BaseUnitControl";
import { PanelMeasuresBlock, type SuggestionCandidate } from "./PanelMeasuresBlock";
import { PanelYieldRow } from "./PanelYieldRow";
import { PanelChipsRow } from "./PanelChipsRow";
import { useSaveWithRefresh } from "./useSaveWithRefresh";
import { dropParents } from "../parentsStore";

export function PanelIngredientZone({
  ingredient,
  // N8 fix 3: item in scope -> measure note states the derived price
  // for THIS item; ingredient-only mode -> generic sentence.
  item,
  parentOptions,
  onDone,
  measureOpen,
  costedPerFocusNonce,
  suggestionCandidates: suggestionCandidatesProp,
  itemsReachBase: itemsReachBaseProp,
}: {
  ingredient: ReviewCardIngredient;
  item: ReviewGroupItem | null;
  parentOptions: string[];
  onDone: () => void;
  // M2 §4B part 3 fix 6: DetailPanel threads these so attention
  // buttons can open the measures block prefilled + focus the
  // Costed per control. Polish round 2 fix 1: pickUnit=true means
  // the user has NOT chosen a to-unit yet (needs_measure path);
  // the Measures block leaves the to-unit blank and limits the
  // options to the uom's dim.
  measureOpen?: { uom: string; qty: number | null; pickUnit: boolean; nonce: number } | null;
  costedPerFocusNonce?: number;
  suggestionCandidates?: Array<{ id: string; packQty: number | null; packSize: number | null; packUom: string | null; usd12m: number }>;
  itemsReachBase?: boolean;
}) {
  // --- Rename ----------------------------------------------------
  // T4 §3: rename + category both drive the shared save-and-refresh
  // helper so the Rename primary + the Category selects both stay
  // busy until the refreshed server data has rendered. Rename also
  // calls dropParents() on success because a renamed ingredient is a
  // new string in the parents list (Merge picker + Sub-category
  // dropdown both see the new name on their next open).
  const [renameDraft, setRenameDraft] = useState(ingredient.name);
  const { save: runRename, busy: renameBusy, savedAt: renameSavedAt, error: renameError } = useSaveWithRefresh();

  // --- Category --------------------------------------------------
  const [superDraft, setSuperDraft] = useState<string>(ingredient.category ?? "");
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(ingredient.parent ?? "");
  const [subNew, setSubNew] = useState("");
  const { save: runCategory, busy: catBusy, savedAt: catSavedAt, error: catError } = useSaveWithRefresh();

  // M2 §4B: wiring the new Measures + Chips + Yield blocks.
  //   - measuresForBlock: ingredient's measures list (M1 payload adds
  //     it onto ReviewCardIngredient; falls back to the one-row legacy
  //     shape if a caller is still on the pre-M2 type).
  //   - addForUom: a dashed chip click signals the measures Add row
  //     to open prefilled.
  //   - suggestionCandidates: not wired from PanelIngredientZone yet;
  //     IngredientMasters tab can pass linked items' pack shapes once
  //     the prop lands. Empty here means no suggestion row renders.
  //   - itemsReachBase: suggestion-rule gate (§2.4 rule 5). Safe
  //     default is true (do not surface a suggestion when we have no
  //     signal). The item panel's parent knows the linked items'
  //     reach; it can pass this prop in a follow-up.
  const [addForUom, setAddForUom] = useState<string | null>(null);
  const [addPrefillQty, setAddPrefillQty] = useState<number | null>(null);
  // Polish round 2 fix 1: pickUnit=true means the Measures block
  // leaves the to-unit blank and limits the options to addForUom's dim.
  const [addPickUnit, setAddPickUnit] = useState<boolean>(false);
  // Watch DetailPanel's bus: when attention fires "Add a measure",
  // open the measures block's add row with the bridge uom + prefill.
  useEffect(() => {
    if (!measureOpen) return;
    setAddForUom(measureOpen.uom);
    setAddPrefillQty(measureOpen.qty ?? null);
    setAddPickUnit(measureOpen.pickUnit);
  }, [measureOpen?.nonce, measureOpen?.uom, measureOpen?.qty, measureOpen?.pickUnit, measureOpen]);
  const measuresForBlock =
    (ingredient.measures as
      | Array<{ from_unit: string; qty: number; to_unit: string; source: string }>
      | undefined) ?? [];
  const suggestionCandidates: SuggestionCandidate[] = suggestionCandidatesProp ?? [];
  const itemsReachBase = itemsReachBaseProp ?? true;

  // M2 §4B part 3 fix 6: focus the Costed per control when the
  // "Change Costed per" attention button fires.
  const costedPerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!costedPerFocusNonce) return;
    const el = costedPerRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const first = el.querySelector("select, input, button") as HTMLElement | null;
    first?.focus();
  }, [costedPerFocusNonce]);

  // M2 §4B part 2: the N6 measure state (measureBaseline/measureDraft/
  // doMeasureSave/doMeasureClear) is gone. The new PanelMeasuresBlock
  // owns all measure editing via /api/review/set-ingredient-measures;
  // no screen reads ingredient.each_measure_* any more.

  // Keep rename/category drafts in sync when the ingredient reloads
  // underneath.
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

  async function doRename() {
    const next = renameDraft.trim();
    if (renameBusy) return;
    if (next.length < 2) { toast("Name is too short", { tone: "block" }); return; }
    if (next === ingredient.name) { toast("Same name, nothing to save"); return; }
    await runRename({
      op: () =>
        postJson("/api/review/rename-ingredient", {
          ingredientId: ingredient.id,
          newName: next,
        }),
      successMessage: (d) => {
        let aliasWritten = false;
        if (d && typeof d === "object") {
          const rec = d as { aliasWritten?: unknown };
          if (typeof rec.aliasWritten === "boolean") aliasWritten = rec.aliasWritten;
        }
        return aliasWritten
          ? "Saved - old name kept as an alias so links survive"
          : "Saved: name";
      },
      errorFallback: "Rename failed",
      // T4 §2a: a rename changes the string the Merge picker shows,
      // and both pickers (Merge + Sub-category) read through the
      // parents cache. Drop it so the next open re-fetches fresh.
      onAfterSuccess: dropParents,
      onDone,
    });
  }

  async function doCategory(opts: {
    nextSuper: SuperCategory | null;
    nextSub: string | null;
  }) {
    if (catBusy) return;
    const current: SuperCategory | null = (ingredient.category as SuperCategory | null) ?? null;
    const currentSub = ingredient.parent ?? null;
    if (opts.nextSuper === current && opts.nextSub === currentSub) return;
    const r = await runCategory({
      op: () =>
        postJson("/api/review/set-category", {
          ingredientId: ingredient.id,
          category: opts.nextSuper,
          parent: opts.nextSub,
        }),
      successMessage: opts.nextSuper
        ? `Saved: category ${opts.nextSuper}`
        : "Saved: Needs category",
      // Category changes also affect the parents list the dropdowns
      // read from (the new parent may not exist yet).
      onAfterSuccess: dropParents,
      onDone,
    });
    if (!r.ok) {
      // Error path still rolls the drafts back to the ingredient's
      // current server values so the dropdowns stop echoing a
      // picked-but-failed state.
      setSuperDraft(ingredient.category ?? "");
      setSubPick(ingredient.parent ?? "");
      setSubNew("");
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

  // M2 §4B part 2: measureFoot removed. PanelMeasuresBlock owns the
  // saved-state copy below its own list rows.

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
      <div className="kf-ipanel__row kf-ipanel__row--split kf-ipanel__row--costed" ref={costedPerRef}>
        <div className="kf-ipanel__row-label">Costed per</div>
        <BaseUnitControl
          row={{ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.base_unit }}
          onSaved={onDone}
        />
        <div className="kf-ipanel__row-hint">How recipes count this ingredient.</div>
      </div>

      {/* M2 §4B §2.3: Measures block, shown for every ingredient
          whatever base_unit is. Replaces the N6 "One each is" row.
          Writes through /api/review/set-ingredient-measures (RPC-
          backed; one Save for the whole list). */}
      <PanelMeasuresBlock
        ingredient={ingredient}
        measures={measuresForBlock}
        suggestionCandidates={suggestionCandidates}
        itemsReachBase={itemsReachBase}
        openAddForUom={addForUom}
        openAddPrefillQty={addPrefillQty}
        openAddPickUnit={addPickUnit}
        onAfterAdd={() => { setAddForUom(null); setAddPrefillQty(null); setAddPickUnit(false); }}
        onDone={onDone}
      />

      {/* M2 §4B §2.5: Yield row. Writes through
          /api/review/set-ingredient-yield. Yield changes NO price
          anywhere in M2 - stored and returned only. */}
      <PanelYieldRow
        ingredient={ingredient}
        yieldPct={ingredient.yieldPct ?? null}
        yieldSource={ingredient.yieldSource ?? null}
        onDone={onDone}
      />

      {/* M2 §4B §2.6: "Recipes can use" chips. Clicking a dashed
          chip opens the measures Add form prefilled for that uom.
          itemUnits is derived from the suggestion candidates passed
          down from DetailPanel - those carry each linked item's
          pack uom so the reach starts from real data, not from
          core five unconditionally. */}
      <PanelChipsRow
        ingredient={ingredient}
        measures={measuresForBlock as Array<{ from_unit: string; qty: number; to_unit: string; source: "house_test" | "book" | "vendor_spec" | "estimate" | "pack" }>}
        itemUnits={Array.from(new Set(suggestionCandidates.map((c) => (c.packUom ?? "").toUpperCase()).filter(Boolean)))}
        onAddForUom={(u) => { setAddForUom(u); setAddPrefillQty(null); setAddPickUnit(false); }}
      />

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
