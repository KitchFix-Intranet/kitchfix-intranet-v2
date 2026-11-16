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

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    closeBtnRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
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
        onClick={close}
        aria-hidden
      />
      <aside
        ref={asideRef}
        className={`kf-drawer${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <PanelHead
          ref={closeBtnRef}
          labelId={labelId}
          kind={open.kind}
          item={item}
          ingredient={ingredient}
          proposedName={proposedName}
          attentionCount={attentionCounts.total}
          onClose={close}
        />

        {open.kind === "item" && item ? (
          <PanelStrip item={item} ingredient={ingredient} />
        ) : null}

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
      </aside>
    </>
  );
}

// N13 R5: inline footer with Archive + Mark one-off. Same behaviour
// as the retired ItemStatusActions (POST /api/vendor-items/[id]/status,
// toast with Undo to the prior status) - renders only when the panel
// is opened from the Vendor items tab (showStatusActions prop).
function ItemStatusFooter({ item, onDone }: { item: ReviewGroupItem; onDone: () => void }) {
  const [busy, setBusy] = useState<null | "archived" | "one_off">(null);
  async function post(next: string): Promise<string | null> {
    const res = await fetch(`/api/vendor-items/${item.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) return null;
    try {
      const body = await res.text();
      return body || `Status ${res.status}`;
    } catch {
      return `Status ${res.status}`;
    }
  }
  async function set(next: "archived" | "one_off", successCopy: string) {
    if (busy) return;
    setBusy(next);
    const prior = item.status ?? "active";
    const err = await post(next);
    if (err) {
      toast(err, { tone: "block" });
      setBusy(null);
      return;
    }
    toast(successCopy, {
      undo: async () => {
        const errUndo = await post(prior);
        if (errUndo) {
          toast(errUndo, { tone: "block" });
          return;
        }
        onDone();
      },
    });
    onDone();
  }
  return (
    <div className="kf-ipanel__footer-strip">
      <span className="kf-ipanel__footer-label">Not for recipes</span>
      <div className="kf-ipanel__footer-actions">
        <button
          type="button"
          className={`kf-btn kf-btn--soft kf-btn--sm${busy === "archived" ? " is-busy" : ""}`}
          disabled={busy !== null || item.status === "archived"}
          onClick={() => set("archived", "Archived")}
        >
          Archive
        </button>
        <button
          type="button"
          className={`kf-btn kf-btn--soft kf-btn--sm${busy === "one_off" ? " is-busy" : ""}`}
          disabled={busy !== null || item.status === "one_off"}
          onClick={() => set("one_off", "Marked one-off")}
        >
          Mark one-off
        </button>
      </div>
    </div>
  );
}
