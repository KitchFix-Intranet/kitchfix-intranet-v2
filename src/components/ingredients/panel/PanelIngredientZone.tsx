"use client";

// N7 §3e: the INGREDIENT zone. Sky ground, full width. Zone head
// (ingredient name + micro line + Retail pill) + five rows in the
// row primitive:
//   1. Name     (rename input + Save button, kept explicit for aliasing)
//   2. Category (super + sub selects, self-save)
//   3. Costed per (BaseUnitControl, self-save)
//   4. One each of {name} is (ingredient each measure, self-save)
//   5. Allergens (IngredientAllergens, kept editor markup)
//
// Retail and Merge live in PanelClosedRows (§3f), not here.
//
// Pending (ai-new) state renders in the same zone shape with the
// proposed name + a hint pointing at the Create button.

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { IngredientAllergens } from "../IngredientAllergens";
import type { ReviewCardIngredient } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";
import { BaseUnitControl } from "./BaseUnitControl";

export function PanelIngredientZone({
  ingredient,
  parentOptions,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  parentOptions: string[];
  onDone: () => void;
}) {
  const [renameDraft, setRenameDraft] = useState(ingredient.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameSavedAt, setRenameSavedAt] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [superDraft, setSuperDraft] = useState<string>(ingredient.category ?? "");
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(ingredient.parent ?? "");
  const [subNew, setSubNew] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [catSavedAt, setCatSavedAt] = useState<number | null>(null);
  const [catError, setCatError] = useState<string | null>(null);

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

  // Keep local drafts in sync when the ingredient reloads underneath
  // (B6 refetch path): new ingredient id or a stored-value change.
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

  // Rename: explicit Save button (alias write makes this a deliberate
  // gesture, not a self-save). Enter inside the input also saves.
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

  // Category: self-save on select change.
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

  // Each measure: self-save on blur / unit-change when qty valid.
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

  return (
    <section className="kf-ipanel__zone kf-ipanel__zone--ing" aria-label="Ingredient">
      <header className="kf-ipanel__zone-head">
        <h4>Ingredient &middot; {ingredient.name}</h4>
        <span className="kf-ipanel__zone-head-right">
          {ingredient.resale ? (
            <span className="kf-pill kf-pill--muted">Retail</span>
          ) : null}
          <span>reversible; each save logs to the ledger</span>
        </span>
      </header>

      {/* Row 1: Name - explicit Save button. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Name</span>
          <span className="kf-ipanel__row-label-sub">old name kept as an alias</span>
        </div>
        <div className="kf-ipanel__row-value">
          <input
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void doRename(); }
            }}
            placeholder="Ingredient name"
            disabled={renameBusy}
          />
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${renameBusy ? " is-busy" : ""}`}
            disabled={renameBusy || renameDraft.trim().length < 2 || renameDraft.trim() === ingredient.name}
            onClick={doRename}
          >
            {renameBusy ? "Saving..." : "Save name"}
          </button>
          <SaveFlash savedAt={renameSavedAt} error={renameError} />
        </div>
      </div>

      {/* Row 2: Category - self-save. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Category</span>
          <span className="kf-ipanel__row-label-sub">super and sub</span>
        </div>
        <div className="kf-ipanel__row-value">
          <div className="kf-ipanel__row-value-flex">
            <select
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
              />
            )}
          </div>
          <SaveFlash savedAt={catSavedAt} error={catError} />
        </div>
        <div className="kf-ipanel__row-action">
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ new sub" : "pick existing"}
          </button>
        </div>
      </div>

      {/* Row 3: Costed per - BaseUnitControl. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Costed per</span>
          <span className="kf-ipanel__row-label-sub">weight, volume, or each</span>
        </div>
        <div className="kf-ipanel__row-value">
          <BaseUnitControl
            row={{ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.base_unit }}
            onSaved={onDone}
          />
        </div>
        <div className="kf-ipanel__row-action" />
      </div>

      {/* Row 4: One each of {name} is - only for each-costed masters. */}
      {ingredient.base_unit === "each" ? (
        <div className="kf-ipanel__row">
          <div className="kf-ipanel__row-label">
            <span>One each of {ingredient.name} is</span>
            <span className="kf-ipanel__row-label-sub">weight or volume</span>
          </div>
          <div className="kf-ipanel__row-value">
            <div className="kf-ipanel__row-value-flex">
              <input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                value={measureQtyDraft}
                onChange={(e) => setMeasureQtyDraft(e.target.value)}
                onBlur={() => { void doMeasureSave(); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void doMeasureSave(); } }}
                placeholder="e.g. 6"
                aria-label="One each, quantity"
                disabled={measureBusy}
                style={{ maxWidth: 120 }}
              />
              <select
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
              <select
                value={measureSourceDraft}
                onChange={(e) => setMeasureSourceDraft(e.target.value)}
                disabled={measureBusy}
                aria-label="Measure source"
              >
                <option value="house_test">Measured in house</option>
                <option value="book">Book value</option>
                <option value="vendor_spec">Vendor spec</option>
                <option value="estimate">Estimate</option>
              </select>
            </div>
            <SaveFlash savedAt={measureSavedAt} error={measureError} />
          </div>
          <div className="kf-ipanel__row-action">
            <button
              type="button"
              className="kf-btn kf-btn--line kf-btn--sm"
              disabled={measureBusy || (measureQtyDraft.trim() === "" && ingredient.each_measure_qty == null)}
              onClick={doMeasureClear}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {/* Row 5: Allergens - keeps its internal markup per B4. */}
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Allergens</span>
          <span className="kf-ipanel__row-label-sub">confirm the list</span>
        </div>
        <div className="kf-ipanel__row-value">
          <IngredientAllergens
            ingredientId={ingredient.id}
            allergens={ingredient.allergens}
            reviewedBy={ingredient.allergens_reviewed_by}
            reviewedAt={ingredient.allergens_reviewed_at}
            onSaved={onDone}
          />
        </div>
        <div className="kf-ipanel__row-action" />
      </div>
    </section>
  );
}

// Pending (ai-new) state - same zone shape, but only a hint row.
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
        <h4>Ingredient &middot; not yet created</h4>
        <span className="kf-ipanel__zone-head-right">
          <span>finish the create flow to edit</span>
        </span>
      </header>
      <div className="kf-ipanel__row">
        <div className="kf-ipanel__row-label">
          <span>Proposed</span>
        </div>
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
