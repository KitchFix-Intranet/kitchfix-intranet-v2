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
  // N13 R5: Archive + Mark one-off footer renders ONLY when the
  // panel is opened from the Vendor items tab. Default off.
  showStatusActions?: boolean;
}) {
  const router = useRouter();
  const labelId = useId();
  const asideRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState(false);
  // Pack-hint from PanelAttention's "Fix the pack" button; threaded
  // into PanelItemZone which forces the Pack and price row open.
  const [packHint, setPackHint] = useState<PackHint | null>(null);
  // M2 §4B part 3 fix 6: shared bus from PanelAttention's buttons to
  // PanelIngredientZone's measures block. "Add a measure" sets an
  // open-with-uom + prefill bump; "Change Costed per" bumps a nonce
  // that PanelIngredientZone watches to scroll + focus the control.
  // Polish round 2 fix 1: `pickUnit` means "limit the to-unit options
  // to this uom's dim and leave the choice blank" - the needs_measure
  // path. sizes_differ ships qty + uom (pickUnit=false), so its unit
  // sticks. Chips also ship uom only; see onAddMeasure below for the
  // qty-null -> pickUnit inference.
  const [measureOpen, setMeasureOpen] = useState<{ uom: string; qty: number | null; pickUnit: boolean; nonce: number } | null>(null);
  const [costedPerFocusNonce, setCostedPerFocusNonce] = useState(0);

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

  // T2 §3: the discard-what-you-typed ask. Opened by any of the three
  // doors (Esc, close button, backdrop click) when at least one editor
  // under the panel reports a changed value. Keep editing is the
  // default (focus lands on it); Discard resets every dirty editor to
  // its baseline and closes the panel.
  const [discardAskOpen, setDiscardAskOpen] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    if (closing) return;
    setClosing(true);
    // T2 round 2 §4: no clearAll here. Every editor's useEffect
    // cleanup already removes its entry on unmount; closing the
    // panel must not touch editors outside this scope.
    window.setTimeout(onClose, EXIT_MS);
  };

  const tryClose = () => {
    if (anyDirty(PANEL_SCOPE)) {
      setDiscardAskOpen(true);
      return;
    }
    close();
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
    closeBtnRef.current?.focus();
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
        {/* T8: PanelHead and PanelStrip share one sticky wrapper so
            the four summary cells stay on screen during a scroll.
            Costs about 48 px of pinned real estate (head + strip).
            T7's thin facts line was removed; it was a workaround
            for this same problem and reads worse than the labelled
            block. The wrapper is item-mode-aware through the strip's
            own render guard: ingredient mode gets a head-only wrapper. */}
        <div className="kf-ipanel__pin">
          <PanelHead
            ref={closeBtnRef}
            labelId={labelId}
            kind={open.kind}
            item={item}
            ingredient={ingredient}
            proposedName={proposedName}
            attentionCount={attentionCounts.total}
            onClose={tryClose}
          />

          {open.kind === "item" && item ? (
            <PanelStrip item={item} ingredient={ingredient} />
          ) : null}
        </div>

        {open.kind === "item" && item ? (
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

        {open.kind === "item" && item ? (
          <PanelItemZone
            item={item}
            ingredient={ingredient}
            packHint={packHint}
            onDone={onDone}
          />
        ) : null}

        {ingredient ? (
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
            proposedName={proposedName ?? null}
            proposedParent={proposedParent ?? null}
          />
        )}

        <PanelClosedRows
          item={item}
          ingredient={ingredient}
          parents={parents}
          onLoadParents={onLoadParents}
          onDone={onDone}
        />

        {showStatusActions && item ? (
          <ItemStatusFooter item={item} onDone={() => {
            // N13 R5: after a change close the panel and refresh the
            // underlying list. router.refresh() picks up the status
            // flip from the server-rendered VendorItemsPage.
            close();
            router.refresh();
            if (onInvalidate) onInvalidate();
          }} />
        ) : null}

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
                  onClick={() => setDiscardAskOpen(false)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => {
                    discardAll(PANEL_SCOPE);
                    setDiscardAskOpen(false);
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

// T4 §5 + §7: inline footer with Archive, Mark one-off and Restore.
// Each button routes through /api/vendor-items/[id]/status with the
// three allowed actions; the server runs them through markArchived /
// markOneOff / restoreVendorItem so the full shape (status +
// link_status + link_reason) is set and the decision event carries a
// before snapshot Undo can read.
//
// T4 R2 §3: Archive-disabled / One-off-disabled / Restore-visible
// branch on `item.state` and `item.canRestore`, which the server
// computed via getVendorItemState / canRestore. The panel does not
// read `item.status` / `item.isFood` / `item.link_reason` directly.
//
// T4 R2 §4: Restore uses the in-page "What happens" ask (same shape
// as Send back): one sentence, then Restore + Cancel. Archive and
// One-off act at once with Undo in the toast.
function ItemStatusFooter({ item, onDone }: { item: ReviewGroupItem; onDone: () => void }) {
  const [busy, setBusy] = useState<null | "archive" | "one-off" | "restore">(null);
  const [error, setError] = useState<string | null>(null);
  // T4 R2 §4: Restore uses the in-page ask. Open on click; the ask
  // carries the "What happens" sentence and Restore / Cancel.
  const [restoreAsk, setRestoreAsk] = useState(false);
  const router = useRouter();

  // T4 R2 §3: the state the server resolved. Both old and new shapes
  // land on these labels.
  const state = item.state ?? "";
  const isLinked = (item.linkStatus ?? "") === "confirmed";
  const isArchived = state === "archived";
  const isOneOff = state === "one_off";
  const showRestore = item.canRestore === true;

  async function run(action: "archive" | "one-off" | "restore", successCopy: string) {
    if (busy) return;
    setBusy(action);
    setError(null);
    const r = await postJson(`/api/vendor-items/${item.id}/status`, { action });
    if (!r.ok) {
      setError(saveErrorSentence(r) ?? "Nothing was saved.");
      setBusy(null);
      return;
    }
    const d = (r.data ?? {}) as { event_id?: string | null };
    toast(successCopy, {
      undo: d.event_id ? undoViaEvent(router, d.event_id) : undefined,
    });
    onDone();
    setBusy(null);
  }

  async function doRestore() {
    setRestoreAsk(false);
    await run("restore", "Restored - back to not matched yet");
  }

  return (
    <div className="kf-ipanel__footer-strip">
      <span className="kf-ipanel__footer-label">Not for recipes</span>
      <div className="kf-ipanel__footer-actions">
        <button
          type="button"
          className={`kf-btn kf-btn--soft kf-btn--sm${busy === "archive" ? " is-busy" : ""}`}
          disabled={busy !== null || isLinked || isArchived}
          onClick={() => run("archive", "Archived")}
          title={isLinked ? "Send this item back to review first." : undefined}
        >
          Archive
        </button>
        <button
          type="button"
          className={`kf-btn kf-btn--soft kf-btn--sm${busy === "one-off" ? " is-busy" : ""}`}
          disabled={busy !== null || isLinked || isOneOff}
          onClick={() => run("one-off", "Marked one-off")}
          title={isLinked ? "Send this item back to review first." : undefined}
        >
          Mark one-off
        </button>
        {showRestore ? (
          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${busy === "restore" ? " is-busy" : ""}`}
            disabled={busy !== null || restoreAsk}
            onClick={() => setRestoreAsk(true)}
            title="Put this item back to not matched yet; it can be matched again."
          >
            Restore
          </button>
        ) : null}
        {isLinked ? (
          <span className="kf-ipanel__footer-note" role="note">
            Linked to an ingredient. Send it back to review first.
          </span>
        ) : null}
        {error ? (
          <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      {restoreAsk ? (
        <div className="kf-ipanel__footer-ask" role="alertdialog" aria-label="Restore?">
          <p className="kf-ipanel__footer-ask-text">
            This item goes back to not matched yet and can be matched again.
          </p>
          <div className="kf-ipanel__footer-ask-actions">
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
