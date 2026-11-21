"use client";

// Right-side slide-in detail panel for the review queue.
//
// N7 composition (final):
//   head          §3a  PanelHead
//   summary strip §3b  PanelStrip                (item modes only)
//   attention     §3c  PanelAttention            (item modes only)
//   this item     §3d  PanelItemZone             (item modes only)
//   ingredient    §3e  PanelIngredientZone[Pending]
//   closed rows   §3f  PanelClosedRows           (retail / merge /
//                                                  evidence / history)
//
// Shell owns: drawer chrome (backdrop, slide-in, focus trap, Escape).
// B4: editor internals (PackOverrideBlock, PriceOverrideBlock,
// ItemGradeBlock, EvidenceBody, IngredientAllergens, ledger list)
// keep their inner markup + classes.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { postJson, saveErrorSentence, undoViaEvent } from "./panel/common";
import { anyDirty, discardAll, DirtyScopeProvider } from "./panel/dirty";

// T2 round 2 §4: every editor inside the item panel registers under
// this scope. The Ingredients-tab drill-in re-mounts the same blocks
// without a provider, so those registrations fall through to no-op.
const PANEL_SCOPE = "item-panel";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";
import { PanelHead } from "./panel/PanelHead";
import { PanelStrip } from "./panel/PanelStrip";
import { PanelAttention, computeAttentionCounts } from "./panel/PanelAttention";
import { PanelItemZone } from "./panel/PanelItemZone";
import { PanelIngredientZone, PanelIngredientZonePending } from "./panel/PanelIngredientZone";
import { PanelClosedRows } from "./panel/PanelClosedRows";
import type { PackHint } from "./panel/packHelpers";
import "./drawer.css";
// N13: item-panel extensions (history closed rows + status footer)
// ride in the same stylesheet as the Vendor items tab since both
// surface the same primitives. DetailPanel opens on review queue /
// Ingredients tab / Vendor items tab; importing here keeps the CSS
// loaded wherever the panel mounts.
import "./vendor-items-tab.css";
// N13.1 §3: EvidenceSection (sibling rows) uses .kf-cell-strong /
// .kf-cell-ellipsis / .kf-cell-sub. Those rules live in table.css; the
// panel owns its imports so it renders the same on every surface.
import "./table.css";
// N13.1 §3: site pills live in both the strip and the review card;
// their rules moved out of review.css into a shared sheet so both
// readers import the one source.
import "./site-pills.css";

export type DetailPanelOpen =
  | null
  | { kind: "item"; itemId: string }
  | { kind: "ingredient" };

const EXIT_MS = 200;

export function DetailPanel({
  open,
  onClose,
  ingredient,
  items,
  parents,
  parentOptions: parentOptionsProp,
  onLoadParents,
  proposedName,
  proposedParent,
  onInvalidate,
  showStatusActions = false,
  stepIndex = null,
  stepTotal = null,
  onPrev,
  onNext,
  onFocusReturn,
  sendAllBack,
}: {
  open: Exclude<DetailPanelOpen, null>;
  onClose: () => void;
  // null for ai-new groups where the ingredient doesn't exist yet.
  ingredient: ReviewCardIngredient | null;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
  // T4 §2a: distinct sub-category names. When the caller hands these
  // in (Ingredients tab's ItemPanelById), the panel reads them
  // directly and never computes from `parents` (which is empty on
  // that path). Review queue path still passes the full ingredients
  // list as `parents` and leaves this undefined; the memo below
  // derives parentOptions the way it always has.
  parentOptions?: string[];
  // T4 §2a: lazy loader for the full active-ingredient list, used by
  // the Merge row only. Undefined on the review queue path (where
  // `parents` already carries the full list).
  onLoadParents?: () => Promise<ReviewCardIngredient[]>;
  proposedName?: string | null;
  proposedParent?: string | null;
  // N7 B6: callers that fetch panel data themselves (ItemPanelById)
  // pass a refetch fn; it fires after any panel write that would
  // change the data the wrapper fetched. ReviewCard leaves it
  // undefined and router.refresh() handles the server path.
  onInvalidate?: () => void;
  showStatusActions?: boolean;
  stepIndex?: number | null;
  stepTotal?: number | null;
  onPrev?: () => void;
  onNext?: () => void;
  // T6 round 2 item 2: focus returns to the opener row on close.
  // Callers pass a callback that focuses the row they opened (or
  // the row the user last stepped to). Fired AFTER the exit
  // animation runs so the panel has released the focus trap.
  onFocusReturn?: () => void;
  // T7 R2 item 1: the ingredient drawer opened from the Ingredients
  // / Retail tabs offers Send all back for an ingredient with linked
  // items. The review card's pencil leaves this unset (confirm has
  // not happened yet; nothing to send back).
  sendAllBack?: { masterName: string; itemIds: string[] };
}) {
  const router = useRouter();
  const labelId = useId();
  const asideRef = useRef<HTMLDivElement>(null);
  // T6 ruling 9: on open, focus goes to the panel's name heading
  // (made focusable via tabIndex=-1). A screen reader then hears what
  // opened and the first Tab lands on the first real control.
  const headNameRef = useRef<HTMLHeadingElement>(null);
  const [closing, setClosing] = useState(false);

  // T6 round 4 item 1: EVERYTHING the panel draws below the head for
  // an item - PanelStrip, the AwayBar, PanelAttention, PanelItemZone,
  // PanelIngredientZone (which holds the measure editor), the four
  // folds in PanelClosedRows - now lives inside ItemPanelBody, which
  // the render below mounts with `key={item.id}`. React unmounts the
  // body on a step to another item and remounts it fresh, so no piece
  // of local state in any descendant survives a step. State THAT USED
  // TO LIVE HERE because it crossed those children (packHint from
  // Attention -> PanelItemZone, measureOpen + costedPerFocusNonce
  // from Attention -> PanelIngredientZone) moved into ItemPanelBody
  // so the same remount discards it. Nothing panel-level needs a
  // currentItemId reset effect any more; the only two slots
  // DetailPanel still owns (discardAskOpen + pendingStep) are reset
  // explicitly by every path that closes the ask (Keep editing,
  // Discard, close()) and by the useEffect below as belt-and-braces
  // for an external item-id swap mid-ask (ItemPanelById re-key).
  const currentItemId = open.kind === "item" ? open.itemId : null;
  useEffect(() => {
    setDiscardAskOpen(false);
    setPendingStep(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItemId]);

  // T4 §2a: when the caller passed parentOptions explicitly, use it;
  // otherwise derive from `parents` the way we always have. Review
  // queue callers still pass the full ingredients list as `parents`
  // and leave parentOptions undefined.
  const parentOptions = useMemo(() => {
    if (parentOptionsProp) return parentOptionsProp;
    const set = new Set<string>();
    for (const p of parents) {
      if (p.parent && p.parent.trim().length > 0) set.add(p.parent);
    }
    return Array.from(set).sort();
  }, [parents, parentOptionsProp]);

  const item = open.kind === "item" ? items.find((i) => i.id === open.itemId) ?? null : null;

  // T4 §3: the panel's descendants route their saves through
  // useSaveWithRefresh, which fires router.refresh() inside a
  // transition and keeps the control busy until the refresh has
  // rendered. All onDone needs to do here is invalidate the wrapper
  // fetch (ItemPanelById) when one is attached - the refresh itself
  // is the hook's job. Leaving router.refresh() here would be a
  // double refresh.
  const onDone = () => {
    if (onInvalidate) onInvalidate();
  };

  // T2 §3 + T6 round 2 item 1: the discard-what-you-typed ask.
  // Three doors open it with any editor dirty: Esc / Close / backdrop
  // click (kind="close"), and Prev / Next (kind="step"). The step
  // path runs the saved step function after the user discards.
  const [discardAskOpen, setDiscardAskOpen] = useState(false);
  const [pendingStep, setPendingStep] = useState<(() => void) | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  // T6 round 4 small 1: remember the field the person was in when
  // the panel-level ask opened, so Keep editing returns focus there
  // (matching the four editors' own Keep-editing behaviour). Captured
  // in tryClose + stepWithAsk; refocused on a micro-task after the
  // ask closes so the ask's buttons have unmounted first.
  const panelAskLastFocusRef = useRef<HTMLElement | null>(null);

  const close = () => {
    if (closing) return;
    setClosing(true);
    // T2 round 2 §4: no clearAll here. Every editor's useEffect
    // cleanup already removes its entry on unmount; closing the
    // panel must not touch editors outside this scope.
    window.setTimeout(() => {
      onClose();
      // T6 round 2 item 2: return focus to the opener row AFTER
      // the panel has closed so the focus trap has released.
      // Scheduled on a microtask to run after the parent re-renders.
      if (onFocusReturn) {
        window.setTimeout(() => {
          try {
            onFocusReturn();
          } catch {
            /* non-fatal */
          }
        }, 0);
      }
    }, EXIT_MS);
  };

  // T6 round 4 small 1: capture the field focus lives on just BEFORE
  // the ask opens, so Keep editing can hand focus back.
  const captureAskLastFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) panelAskLastFocusRef.current = active;
    else panelAskLastFocusRef.current = null;
  };

  const tryClose = () => {
    if (anyDirty(PANEL_SCOPE)) {
      captureAskLastFocus();
      setPendingStep(null);
      setDiscardAskOpen(true);
      return;
    }
    close();
  };

  // T6 round 2 item 1: Prev / Next ask first when something is typed.
  // On Discard, run the step. On Keep editing, stay put.
  const stepWithAsk = (step?: () => void) => {
    if (!step) return undefined;
    return () => {
      if (anyDirty(PANEL_SCOPE)) {
        captureAskLastFocus();
        setPendingStep(() => step);
        setDiscardAskOpen(true);
        return;
      }
      step();
    };
  };

  useEffect(() => {
    if (discardAskOpen) {
      // Focus Keep editing after the ask renders so Enter commits the
      // safe choice.
      const t = window.setTimeout(() => keepEditingRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [discardAskOpen]);

  useEffect(() => {
    // T6 ruling 9: focus the name heading, not the Close button, so
    // a screen reader hears what opened. The heading is marked
    // tabIndex=-1 in PanelHead so this programmatic focus works
    // without adding it to the Tab order.
    headNameRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // If a pick-list (typeahead etc.) already handled Esc it will
        // have called preventDefault + stopPropagation; this listener
        // is at document and only fires for unhandled Esc.
        tryClose();
        return;
      }
      if (e.key === "Tab" && asideRef.current) {
        const focusables = asideRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polish round 2 fix 2: blendedAvgPerBase is computed server-side
  // on the ingredient payload (Review queue, /api/review/item,
  // /api/review/ingredient, IngredientMasters all project it onto the
  // ingredient). The DetailPanel just reads; no client math. Null
  // when the server could not supply one (new ingredient, no priced
  // mates, etc.) - attention falls back to the "outside the blend"
  // head.
  const blendPerBase: number | null = ingredient?.blendedAvgPerBase ?? null;

  const attentionCounts = open.kind === "item" && item
    ? computeAttentionCounts(item, ingredient, [], blendPerBase)
    : { total: 0, hasNoIngredient: false, provenance: { packHandSet: false, priceHandSet: false } };

  return (
    <>
      <div
        className={`kf-drawer__backdrop${closing ? " is-closing" : ""}`}
        onClick={tryClose}
        aria-hidden
      />
      <aside
        ref={asideRef}
        className={`kf-drawer${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
      <DirtyScopeProvider scope={PANEL_SCOPE}>
        {/* T6 item 1: only the head (vendor + # line, name, status,
            step buttons, close) is pinned. The four facts strip moved
            BELOW the pin so it scrolls with the panel. This frees
            the first screen for the editors and keeps the panel at
            about 1.2 screens for an ordinary linked item. The pin
            class scope still gates the item-panel-only shrink rules
            in drawer.css; the Ingredients tab's price tile
            (.kf-ingp__dzone-strip, outside any pin) is unchanged. */}
        <div className="kf-ipanel__pin">
          <PanelHead
            ref={headNameRef}
            labelId={labelId}
            kind={open.kind}
            item={item}
            ingredient={ingredient}
            proposedName={proposedName}
            attentionCount={attentionCounts.total}
            onClose={tryClose}
            stepIndex={stepIndex}
            stepTotal={stepTotal}
            onPrev={stepWithAsk(onPrev)}
            onNext={stepWithAsk(onNext)}
          />
        </div>

        {/* T6 round 4 item 1: everything below the head for an item
            renders inside ItemPanelBody, mounted with `key={item.id}`.
            A step to a sibling item unmounts the body + mounts a
            fresh one, so no local state in ANY descendant - the
            strip, the attention list, the pack/price/case-weight
            editors, the ingredient zone's measure editor and the
            four folds - crosses the step. State that used to live in
            THIS component because it bridged Attention to zone 2
            (packHint, measureOpen, costedPerFocusNonce) moved into
            ItemPanelBody so the same remount discards it. Nothing
            item-scoped sits in DetailPanel any more; see the PR
            comment for the slot-by-slot list. */}
        {open.kind === "item" && item ? (
          <ItemPanelBody
            key={item.id}
            item={item}
            ingredient={ingredient}
            items={items}
            parents={parents}
            parentOptions={parentOptions}
            onLoadParents={onLoadParents}
            proposedName={proposedName ?? null}
            proposedParent={proposedParent ?? null}
            onDone={onDone}
            showStatusActions={showStatusActions}
            blendPerBase={blendPerBase}
          />
        ) : (
          /* Ingredient-mode open: no item identity to key on. The
             ingredient zone and the two closed rows (retail + merge)
             bind their state to the ingredient prop as before. */
          <>
            {ingredient ? (
              <PanelIngredientZone
                ingredient={ingredient}
                item={null}
                parentOptions={parentOptions}
                onDone={onDone}
                suggestionCandidates={[]}
                itemsReachBase={true}
              />
            ) : (
              <PanelIngredientZonePending
                item={null}
                proposedName={proposedName ?? null}
                proposedParent={proposedParent ?? null}
              />
            )}

            <PanelClosedRows
              item={null}
              ingredient={ingredient}
              parents={parents}
              onLoadParents={onLoadParents}
              onDone={onDone}
              mode="ingredient"
              sendAllBack={sendAllBack}
            />
          </>
        )}

        {/* T6 ruling 2: the footer is removed entirely. Archive and
            Mark one-off ride at the end of zone 1 as a "Put this
            item away" row (via showStatusActions); Restore rides in
            the away bar under the head on every surface. */}

      </DirtyScopeProvider>
        {discardAskOpen ? (
          <div
            className="kf-dpn__discard-ask"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${labelId}-discard`}
          >
            <div className="kf-dpn__discard-ask-inner">
              <h4 id={`${labelId}-discard`}>Discard what you typed?</h4>
              <p>Your changes have not been saved.</p>
              <div className="kf-dpn__discard-ask-actions">
                <button
                  ref={keepEditingRef}
                  type="button"
                  className="kf-btn kf-btn--primary kf-btn--sm"
                  onClick={() => {
                    setDiscardAskOpen(false);
                    setPendingStep(null);
                    // T6 round 4 small 1: return focus to the field
                    // the person was in when the ask opened. Micro-
                    // task so this ask's buttons have unmounted by
                    // the time we focus.
                    window.setTimeout(() => {
                      panelAskLastFocusRef.current?.focus();
                    }, 0);
                  }}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => {
                    discardAll(PANEL_SCOPE);
                    setDiscardAskOpen(false);
                    // T6 round 2 item 1: if the ask was opened by
                    // Prev / Next, run the pending step instead of
                    // closing the panel.
                    if (pendingStep) {
                      const step = pendingStep;
                      setPendingStep(null);
                      step();
                      return;
                    }
                    close();
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </>
  );
}

// T6 item 2: when the item is put away, one bar under the head says
// what it is in plain words plus Restore (where train 4's canRestore
// allows it) or "Open that item" for a duplicate. The pack / grade /
// price-by-hand editors below do not render for an away item.
//
// Replaces the retired .kf-ipanel__footer-strip. The two "put this
// item away" actions (Archive, Mark one-off) moved into zone 1 as a
// row (PutAwayRow in PanelItemZone), Vendor-items-only, not-away
// only. Restore uses the same /api/vendor-items/[id]/status route
// train 4 wired, with the in-page ask unchanged.
function itemIsAway(item: ReviewGroupItem): boolean {
  const s = item.state ?? "";
  return s === "archived" || s === "one_off" || s === "not_food" || s === "duplicate";
}

// T6 round 4 item 1: everything below the panel head for an item.
// Owns the three pieces of state that bridge PanelAttention ->
// PanelItemZone (packHint) and PanelAttention -> PanelIngredientZone
// (measureOpen + costedPerFocusNonce). DetailPanel mounts
// `<ItemPanelBody key={item.id}>` so a Prev / Next step remounts the
// WHOLE body: state held here, state held in each editor, draft
// lists in the measures block, open / ask / savedAt flags - all of
// them reset without any per-slot reset code. Measure editor state
// is covered too because PanelIngredientZone (and the measures block
// inside it) now lives inside this body.
function ItemPanelBody({
  item,
  ingredient,
  items,
  parents,
  parentOptions,
  onLoadParents,
  proposedName,
  proposedParent,
  onDone,
  showStatusActions,
  blendPerBase,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
  parentOptions: string[];
  onLoadParents?: () => Promise<ReviewCardIngredient[]>;
  proposedName: string | null;
  proposedParent: string | null;
  onDone: () => void;
  showStatusActions: boolean;
  blendPerBase: number | null;
}) {
  // Pack-hint from PanelAttention's "Fix the pack" button; threaded
  // into PanelItemZone which forces the Pack and price row open.
  const [packHint, setPackHint] = useState<PackHint | null>(null);
  // M2 §4B part 3 fix 6: Attention -> measures block bus. "Add a
  // measure" sets an open-with-uom + prefill bump; "Change Costed
  // per" bumps a nonce that PanelIngredientZone watches to scroll +
  // focus the control. pickUnit mirrors the needs_measure path.
  const [measureOpen, setMeasureOpen] = useState<{ uom: string; qty: number | null; pickUnit: boolean; nonce: number } | null>(null);
  const [costedPerFocusNonce, setCostedPerFocusNonce] = useState(0);

  const away = itemIsAway(item);

  return (
    <>
      {away ? <AwayBar item={item} onDone={onDone} /> : null}

      <PanelStrip item={item} ingredient={ingredient} />

      {!away ? (
        <PanelAttention
          item={item}
          ingredient={ingredient}
          onFixPack={(uom) => setPackHint({ uom, nonce: Date.now() })}
          onAddMeasure={(uom, qty) => setMeasureOpen({ uom, qty: qty ?? null, pickUnit: qty == null, nonce: Date.now() })}
          onChangeCostedPer={() => setCostedPerFocusNonce((n) => n + 1)}
          siblingPacks={items.map((i) => ({
            id: i.id,
            packQty: i.packQty ?? null,
            packSize: i.packSize ?? null,
            packUom: i.packUom ?? null,
            usd12m: i.usd12m,
          }))}
          blendPerBase={blendPerBase}
        />
      ) : null}

      {!away ? (
        <PanelItemZone
          item={item}
          ingredient={ingredient}
          packHint={packHint}
          onDone={onDone}
          showStatusActions={showStatusActions}
        />
      ) : null}

      {/* T6 round 2 item 4: zone 2 only renders when the item is
          not away. For an unmatched item (ingredient is null),
          PanelIngredientZonePending speaks the reference's words
          (item 6). T6 round 4 item 1: the zone now lives inside
          ItemPanelBody so its measure editor remounts on a step. */}
      {away ? null : ingredient ? (
        <PanelIngredientZone
          ingredient={ingredient}
          item={item}
          parentOptions={parentOptions}
          onDone={onDone}
          measureOpen={measureOpen}
          costedPerFocusNonce={costedPerFocusNonce}
          suggestionCandidates={items
            .filter((i) => i.packQty != null && i.packSize != null && i.packUom != null)
            .map((i) => ({
              id: i.id,
              packQty: i.packQty ?? null,
              packSize: i.packSize ?? null,
              packUom: i.packUom ?? null,
              usd12m: i.usd12m,
            }))}
          itemsReachBase={items.every((i) => (i.statusKind ?? "in_blend") !== "needs_measure")}
        />
      ) : (
        <PanelIngredientZonePending
          item={item}
          proposedName={proposedName}
          proposedParent={proposedParent}
        />
      )}

      <PanelClosedRows
        item={item}
        ingredient={ingredient}
        parents={parents}
        onLoadParents={onLoadParents}
        onDone={onDone}
        mode="item"
      />
    </>
  );
}

function AwayBar({ item, onDone }: { item: ReviewGroupItem; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "restore">(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreAsk, setRestoreAsk] = useState(false);
  const state = item.state ?? "";
  const showRestore = item.canRestore === true;
  const words =
    state === "archived"
      ? "Archived. Put away as a mistake or a dead item."
      : state === "one_off"
        ? "One-off. Bought once and kept out of recipes."
        : state === "not_food"
          ? "Not food. Left out of food spend and out of recipes."
          : state === "duplicate"
            ? "Duplicate. Invoices for this item are counted on another item."
            : "Put away.";
  async function doRestore() {
    if (busy) return;
    setBusy("restore");
    setError(null);
    const r = await postJson(`/api/vendor-items/${item.id}/status`, { action: "restore" });
    if (!r.ok) {
      setError(saveErrorSentence(r) ?? "Nothing was saved.");
      setBusy(null);
      return;
    }
    const d = (r.data ?? {}) as { event_id?: string | null };
    toast("Restored - back to not matched yet", {
      undo: d.event_id ? undoViaEvent(router, d.event_id) : undefined,
    });
    setRestoreAsk(false);
    setBusy(null);
    onDone();
  }
  return (
    <div className="kf-ipanel__away" role="status">
      <div className="kf-ipanel__away-body">{words}</div>
      {showRestore ? (
        <div className="kf-ipanel__away-actions">
          {restoreAsk ? (
            <>
              <span className="kf-ipanel__row-hint">
                This item goes back to not matched yet and can be matched again.
              </span>
              <button
                type="button"
                className={`kf-btn kf-btn--primary kf-btn--sm${busy === "restore" ? " is-busy" : ""}`}
                disabled={busy !== null}
                onClick={doRestore}
              >
                {busy === "restore" ? "Saving..." : "Restore"}
              </button>
              <button
                type="button"
                className="kf-btn kf-btn--line kf-btn--sm"
                disabled={busy !== null}
                onClick={() => setRestoreAsk(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`kf-btn kf-btn--line kf-btn--sm${busy === "restore" ? " is-busy" : ""}`}
              disabled={busy !== null}
              onClick={() => setRestoreAsk(true)}
            >
              Restore
            </button>
          )}
        </div>
      ) : null}
      {error ? (
        <div className="kf-dpn__flash kf-dpn__flash--err" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
