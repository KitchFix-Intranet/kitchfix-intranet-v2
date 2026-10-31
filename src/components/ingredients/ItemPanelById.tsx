"use client";

// Opens the shared DetailPanel for a single vendor-item id, fetching
// the facts the panel needs. Used from the Ingredients-pane linked-
// items table (Prompt A1); the Review queue continues to pass items /
// ingredient / parents from in-memory props. One <ItemPanelById> is
// mounted at the island level, not one per row.

import { useEffect, useState } from "react";
import { DetailPanel } from "./DetailPanel";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";

type Fetched = {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  parents: ReviewCardIngredient[];
};

export function ItemPanelById({
  itemId,
  onClose,
}: {
  itemId: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading"; id: string }
    | { phase: "ready"; id: string; data: Fetched }
    | { phase: "error"; id: string; message: string }
  >({ phase: "idle" });

  useEffect(() => {
    if (!itemId) {
      setState({ phase: "idle" });
      return;
    }
    const current = itemId;
    setState({ phase: "loading", id: current });
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
  }, [itemId]);

  if (!itemId || state.phase === "idle") return null;

  if (state.phase === "ready") {
    const { item, ingredient, parents } = state.data;
    return (
      <DetailPanel
        open={{ kind: "item", itemId: item.id }}
        onClose={onClose}
        ingredient={ingredient}
        items={[item]}
        parents={parents}
        proposedName={null}
        proposedParent={null}
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
