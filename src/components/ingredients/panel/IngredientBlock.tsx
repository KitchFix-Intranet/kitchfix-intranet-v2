"use client";

// Ingredient-side editor block: rename, category, retail toggle, each
// measure (N6), allergens, merge. One sub-form per field; each save
// does router.refresh() so the pre-rendered server surfaces re-read.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0. Markup, classes
// and save triggers unchanged.

import React, { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { DIM_BY_UOM, WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { IngredientAllergens } from "../IngredientAllergens";
import { IngredientTypeahead } from "../IngredientTypeahead";
import type { ReviewCardIngredient } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";
import { BaseUnitControl } from "./BaseUnitControl";

export function IngredientBlock({
  ingredient,
  parentOptions,
  parents,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  parentOptions: string[];
  parents: ReviewCardIngredient[];
  onDone: () => void;
}) {
  // Each sub-form owns its own draft + busy flag. All post to a
  // distinct /api/review/* route; on success toast + onDone to refresh
  // the server-rendered cards so the chip/row readouts update.
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

  const [resaleBusy, setResaleBusy] = useState(false);
  const [resaleSavedAt, setResaleSavedAt] = useState<number | null>(null);
  const [resaleError, setResaleError] = useState<string | null>(null);

  // N6: usual measure of one each. Qty + uom + source, where the uom is
  // any weight or volume unit (N5's pounds-only shape is retired). Only
  // rendered for each-costed masters.
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

  // B1: allergen state + handlers moved to the shared
  // IngredientAllergens component (used here AND in the workbench's
  // MasterDetail pane). The component owns selection, Confirm
  // enablement, save, and router.refresh. See IngredientAllergens.tsx.
  // S1: live counts for the "Also moves N confirmed items" hint.
  // Fetched once on mount per ingredient; refreshed after a save so
  // the next toggle shows the new state.
  const [resalePreview, setResalePreview] = useState<{ active: number; resale: number } | null>(null);
  // N7 B7: the preview GET is one of the two requests the panel used
  // to fire on mount. Defer to the first time the user touches the
  // Mark as retail row (focus / hover / click). Same endpoint, later.
  const [resalePreviewArmed, setResalePreviewArmed] = useState(false);
  useEffect(() => {
    if (!resalePreviewArmed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/review/set-resale?ingredientId=${encodeURIComponent(ingredient.id)}`
        );
        const data = (await res.json().catch(() => null)) as
          | { confirmedActive?: number; confirmedResale?: number }
          | null;
        if (cancelled || !res.ok || !data) return;
        setResalePreview({
          active: Number(data.confirmedActive ?? 0),
          resale: Number(data.confirmedResale ?? 0),
        });
      } catch {
        /* non-fatal; hint stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resalePreviewArmed, ingredient.id, resaleSavedAt]);

  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [mergeBusy, setMergeBusy] = useState(false);
  // Other active ingredients to merge INTO. Exclude self; parents is
  // already filtered server-side to status='active'.
  const mergeChoices = useMemo(
    () => parents.filter((p) => p.id !== ingredient.id),
    [parents, ingredient.id]
  );

  // N7 commit 2: self-save on blur / Enter. Silently no-op on the same
  // name or a too-short draft (blur fires every time the input loses
  // focus, so a toast on no-op would spam). Save-is-best-effort: on
  // server failure the draft reverts to the stored name and the inline
  // error shows under the input - the toast is extra, not the signal.
  async function doRename() {
    const next = renameDraft.trim();
    if (renameBusy) return;
    if (next.length < 2) return;
    if (next === ingredient.name) return;
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
      setRenameDraft(ingredient.name);
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

  // N7 commit 2: self-save on select change. Called with the next
  // super + sub so we never read possibly-stale state after a setState.
  // Revert-on-failure: drafts snap back to the stored category/parent
  // and the inline error renders.
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

  // N7 commit 2 (B5 ingredient parity): save the usual measure of one
  // each. Empty draft is now a no-op, not an error - the user cleared
  // the input or hasn't filled it yet; Clear is the explicit path to
  // null. Invalid number is also a no-op; the server-side validation
  // still rejects garbage.
  async function doMeasureSave() {
    if (measureBusy) return;
    const trimmed = measureQtyDraft.trim();
    if (trimmed === "") return;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return;
    const u = measureUomDraft.toUpperCase();
    const dim = DIM_BY_UOM[u];
    if (dim !== "weight" && dim !== "volume") return;
    // Skip the write when draft equals the already-stored value.
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

  async function toggleResale(next: boolean) {
    if (resaleBusy) return;
    setResaleBusy(true);
    setResaleError(null);
    const r = await postJson("/api/review/set-resale", {
      ingredientId: ingredient.id,
      resale: next,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setResaleError(msg);
      toast(msg, { tone: "block" });
      setResaleBusy(false);
      return;
    }
    const d = (r.data ?? {}) as { moved?: number };
    const moved = d.moved ?? 0;
    const base = next ? "Saved: moved to retail bucket" : "Saved: moved to recipe-coverage bucket";
    const direction = next ? "to retail" : "back to active";
    toast(
      moved > 0
        ? `${base} (${fmtCount(moved)} confirmed items moved ${direction})`
        : base
    );
    setResaleSavedAt(Date.now());
    setResaleBusy(false);
    onDone();
  }

  // Merge THIS ingredient (source) INTO a chosen target. Items + active
  // golden links move; source goes status='merged' with merged_into_id
  // set; source's old name becomes a kind='rename' alias on the
  // target. Undo is available from the toast + from the Recent-
  // decisions ledger. See mergeIngredients() for the full write set.
  async function doMerge() {
    if (mergeBusy || !mergeTarget) return;
    const targetRow = parents.find((p) => p.id === mergeTarget);
    const targetName = targetRow?.name ?? "the chosen ingredient";
    const confirmed = window.confirm(
      `Merge "${ingredient.name}" into "${targetName}"?\n\nEvery item on "${ingredient.name}" will move to "${targetName}". This is reversible from the Recent decisions ledger.`
    );
    if (!confirmed) return;
    setMergeBusy(true);
    const r = await postJson("/api/review/merge-ingredient", {
      sourceId: ingredient.id,
      targetId: mergeTarget,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Merge failed (${r.status})`), { tone: "block" });
      setMergeBusy(false);
      return;
    }
    const d = r.data as { movedItems?: number; movedGoldenLinks?: number };
    const srcId = ingredient.id;
    toast(
      `Merged ${d.movedItems ?? 0} items into ${targetName}`,
      {
        undo: async () => {
          await fetch("/api/review/undo-merge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceId: srcId }),
          });
          onDone();
        },
      }
    );
    setMergeBusy(false);
    onDone();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Edit ingredient">
      <header className="kf-drawer__block-head">
        <h4>Edit ingredient</h4>
        <small>reversible; each save logs to the ledger</small>
      </header>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Name</span>
          <input
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => { void doRename(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void doRename(); }
            }}
            placeholder="Ingredient name"
            disabled={renameBusy}
            aria-busy={renameBusy}
          />
        </label>
        <div className="kf-dpn__hint">
          The old name is kept as an alias, so linked items stay linked.
          <SaveFlash savedAt={renameSavedAt} error={renameError} />
        </div>
      </div>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Category</span>
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
          >
            <option value="">Needs category</option>
            {SUPER_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="kf-dpn__label">
          <span>Sub-category</span>
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
              autoFocus
            />
          )}
        </label>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ add new sub-category" : "pick existing"}
          </button>
          <SaveFlash savedAt={catSavedAt} error={catError} />
        </div>
      </div>

      {/* N7 §3e: Costed per. Reuses the shared BaseUnitControl from
          ./BaseUnitControl.tsx so the Ingredients tab and the panel
          cannot drift. B6: onSaved fires onDone() so the panel's
          mount site (ReviewCard via router.refresh, or the ById
          wrappers via onInvalidate) picks up the new base_unit and
          the One-each row appears or disappears without closing. */}
      <div className="kf-dpn__row">
        <BaseUnitControl
          row={{ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.base_unit }}
          onSaved={onDone}
        />
      </div>

      {/* N6 frame C left: usual measure of one each. Weight OR volume
          in any supported unit, qty stored exactly as typed. Rendered
          only for each-costed masters; changing the master's unit
          elsewhere does NOT clear the stored measure, the block just
          stops showing. deriveRecipePrice refuses to convert non-EA
          items, so the measure is harmless to leave on disk. */}
      {ingredient.base_unit === "each" ? (
        <div className="kf-dpn__row">
          <div className="kf-dpn__row kf-newing__row">
            <label className="kf-dpn__label">
              <span>One each of {ingredient.name} is</span>
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
              />
            </label>
            <label className="kf-dpn__label">
              <span>Unit</span>
              <select
                value={measureUomDraft}
                onChange={(e) => {
                  const u = e.target.value;
                  setMeasureUomDraft(u);
                  // N7 B5 (ingredient parity): unit change saves when
                  // the qty draft is valid; otherwise just stores the
                  // selection.
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
            </label>
            <label className="kf-dpn__label">
              <span>Source</span>
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
            </label>
          </div>
          <div className="kf-dpn__btns">
            <button
              type="button"
              className="kf-btn kf-btn--line kf-btn--sm"
              disabled={measureBusy || (measureQtyDraft.trim() === "" && ingredient.each_measure_qty == null)}
              onClick={doMeasureClear}
            >
              Clear
            </button>
            <SaveFlash savedAt={measureSavedAt} error={measureError} />
          </div>
          <div className="kf-dpn__hint">
            Recipes that read per lb, fl oz or gal will use this measure. The stored price stays per each.
          </div>
        </div>
      ) : null}

      <div
        className="kf-dpn__row"
        onFocus={() => setResalePreviewArmed(true)}
        onMouseEnter={() => setResalePreviewArmed(true)}
      >
        <div className="kf-dpn__toggle">
          <label className="kf-dpn__toggle-label">
            <input
              type="checkbox"
              checked={ingredient.resale}
              aria-label="Mark as retail"
              onChange={(e) => {
                const v = e.currentTarget.checked;
                toggleResale(v);
              }}
              disabled={resaleBusy}
            />
            <span>Retail (not a recipe ingredient)</span>
            <SaveFlash savedAt={resaleSavedAt} error={resaleError} />
          </label>
          <div className="kf-dpn__hint">
            Retail items (bottled water, disposables) are tracked but excluded from recipe-coverage.
            {resalePreview
              ? ingredient.resale
                ? resalePreview.resale > 0
                  ? ` Unticking also moves ${fmtCount(resalePreview.resale)} confirmed item${resalePreview.resale === 1 ? "" : "s"} back into the working set.`
                  : ""
                : resalePreview.active > 0
                  ? ` Ticking also moves ${fmtCount(resalePreview.active)} confirmed item${resalePreview.active === 1 ? "" : "s"} out of the working set.`
                  : ""
              : ""}
          </div>
        </div>
      </div>

      {/* B1 (allergens): shared pill grid + Confirm, same component
          the MasterDetail pane renders. Both surfaces are now driven
          by one source of truth; see IngredientAllergens.tsx. */}
      <div className="kf-dpn__row">
        <IngredientAllergens
          ingredientId={ingredient.id}
          allergens={ingredient.allergens}
          reviewedBy={ingredient.allergens_reviewed_by}
          reviewedAt={ingredient.allergens_reviewed_at}
          onSaved={onDone}
        />
      </div>

      <div className="kf-dpn__row">
        <IngredientTypeahead
          ingredients={mergeChoices}
          excludeId={ingredient.id}
          label="Merge into another ingredient"
          placeholder="Type to search survivors..."
          pickedId={mergeTarget || null}
          onPick={(id) => setMergeTarget(id ?? "")}
          busy={mergeBusy}
        />
        <div className="kf-dpn__hint">
          Its items and confirmed links move to the ingredient you choose. &ldquo;{ingredient.name}&rdquo;
          is kept as a merged record and its name becomes an alias, so the matcher routes the old
          name here automatically. Undoable from Recent decisions.
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${mergeBusy ? " is-busy" : ""}`}
            disabled={mergeBusy || !mergeTarget}
            onClick={doMerge}
          >
            {mergeBusy ? "Saving..." : "Merge into chosen"}
          </button>
        </div>
      </div>
    </section>
  );
}
