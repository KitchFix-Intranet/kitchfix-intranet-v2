"use client";

// Opens the shared DetailPanel for a single vendor-item id, fetching
// the facts the panel needs. Used from the Ingredients-pane linked-
// items table (Prompt A1); the Review queue continues to pass items /
// ingredient / parents from in-memory props. One <ItemPanelById> is
// mounted at the island level, not one per row.
//
// T4 §2a: the /api/review/item response used to carry the full active-
// ingredient list as `parents` (~249 KB). It now returns only the
// distinct sub-category names as `parentOptions`. The full list is
// loaded lazily by the Merge row via parentsStore (shared with
// IngredientMastersFilter) when that row is first opened.

import { useCallback, useEffect, useState } from "react";
import { DetailPanel } from "./DetailPanel";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";
import { loadParents as loadParentsFromStore } from "./parentsStore";

type Fetched = {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  parentOptions: string[];
};

export function ItemPanelById({
  itemId,
  onClose,
  showStatusActions = false,
}: {
  itemId: string | null;
  onClose: () => void;
  // N13 R5: Archive + Mark one-off footer renders ONLY when the panel
  // is opened from the Vendor items tab. Default off; the review
  // queue and the Ingredients tab never show it.
  showStatusActions?: boolean;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading"; id: string }
    | { phase: "ready"; id: string; data: Fetched }
    | { phase: "error"; id: string; message: string }
  >({ phase: "idle" });
  // N7 B6: bumped by onInvalidate to re-fetch without closing the panel.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!itemId) {
      setState({ phase: "idle" });
      return;
    }
    const current = itemId;
    // Only move to loading on the initial fetch; nonce bumps keep the
    // panel visible while the next fetch resolves.
    if (state.phase !== "ready" || state.id !== current) {
      setState({ phase: "loading", id: current });
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/review/item?id=${encodeURIComponent(current)}`, {
          method: "GET",
        });
        const data = (await res.json().catch(() => null)) as
          | (Fetched & { error?: undefined })
          | { error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !data || "error" in data) {
          const msg =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `Fetch failed (${res.status})`;
          setState({ phase: "error", id: current, message: msg });
          return;
        }
        const f = data as Fetched;
        if (!f.item) {
          setState({ phase: "error", id: current, message: "No item returned" });
          return;
        }
        setState({ phase: "ready", id: current, data: f });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ phase: "error", id: current, message: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, nonce]);

  // T4 §2a: shared parents loader. The full ingredient list is held
  // in a module-level cache for the life of the page; the Merge row
  // fires this on first expand, Relink + Sub-category do not need
  // it (Relink is review-queue-only; Sub-category reads parentOptions
  // directly from the item payload).
  const loadParents = useCallback(async (): Promise<ReviewCardIngredient[]> => {
    const ingredientId = state.phase === "ready" ? state.data.ingredient?.id ?? state.data.item.id : null;
    if (!ingredientId) return [];
    return loadParentsFromStore(ingredientId);
  }, [state]);

  if (!itemId || state.phase === "idle") return null;

  if (state.phase === "ready") {
    const { item, ingredient, parentOptions } = state.data;
    return (
      <DetailPanel
        open={{ kind: "item", itemId: item.id }}
        onClose={onClose}
        ingredient={ingredient}
        items={[item]}
        parents={[]}
        parentOptions={parentOptions}
        onLoadParents={loadParents}
        proposedName={null}
        proposedParent={null}
        onInvalidate={() => setNonce((n) => n + 1)}
        showStatusActions={showStatusActions}
      />
    );
  }

  // Loading / error share the drawer scrim so the user has a Close
  // target even when the fetch fails. The scrim + close button here
  // mirror DetailPanel's own structure (kf-drawer / kf-drawer__close)
  // so the keyboard focus trap would still work if we needed one.
  const message =
    state.phase === "loading" ? "Loading item..." : `Could not load item: ${state.message}`;
  return (
    <>
      <div className="kf-drawer__backdrop" onClick={onClose} aria-hidden />
      <aside className="kf-drawer" role="dialog" aria-modal="true" aria-label="Item details">
        <button type="button" className="kf-drawer__close" onClick={onClose} aria-label="Close">
          <span aria-hidden>&times;</span>
        </button>
        <div className="kf-drawer__head">
          <h3 className="kf-drawer__name">{state.phase === "loading" ? "Loading" : "Item details"}</h3>
        </div>
        <div className="kf-drawer__block kf-dpn__block">
          <p className="kf-muted">{message}</p>
        </div>
      </aside>
    </>
  );
}
