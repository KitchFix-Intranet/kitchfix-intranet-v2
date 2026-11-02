"use client";

// Opens the shared DetailPanel in ingredient-mode for a single
// pr_ingredients id, fetching the facts the panel needs. Mirror of
// ItemPanelById (A1): the Review queue continues to pass ingredient
// + parents from in-memory props; the Ingredients pane only holds
// the thin MasterRow projection, so the panel needs a second way in -
// by ingredientId, fetching its own facts.
//
// One <IngredientPanelById> is mounted at the island level, not one
// per row.
//
// The fetch shape uses the S4-fixed EvidenceSection pattern: a
// requestedFor ref, deps [ingredientId], cleared on abandon/error.
// Not an effect that depends on the state it sets.

import { useEffect, useRef, useState } from "react";
import { DetailPanel } from "./DetailPanel";
import type { ReviewCardIngredient } from "./itemTypes";

type Fetched = {
  ingredient: ReviewCardIngredient;
  parents: ReviewCardIngredient[];
};

export function IngredientPanelById({
  ingredientId,
  onClose,
}: {
  ingredientId: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading"; id: string }
    | { phase: "ready"; id: string; data: Fetched }
    | { phase: "error"; id: string; message: string }
  >({ phase: "idle" });
  // S4-safe fetch: track which id's request has been started.
  // Prevents the self-cancel loop the first ref-less draft was
  // vulnerable to and lets abandoned/errored requests retry on
  // reopen (requestedFor cleared in cleanup when !done).
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!ingredientId) {
      requestedFor.current = null;
      setState({ phase: "idle" });
      return;
    }
    if (requestedFor.current === ingredientId) return;
    requestedFor.current = ingredientId;
    let cancelled = false;
    let done = false;
    setState({ phase: "loading", id: ingredientId });
    (async () => {
      try {
        const res = await fetch(`/api/review/ingredient?id=${encodeURIComponent(ingredientId)}`, {
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
          requestedFor.current = null;
          setState({ phase: "error", id: ingredientId, message: msg });
          done = true;
          return;
        }
        const f = data as Fetched;
        if (!f.ingredient) {
          requestedFor.current = null;
          setState({ phase: "error", id: ingredientId, message: "No ingredient returned" });
          done = true;
          return;
        }
        setState({ phase: "ready", id: ingredientId, data: f });
        done = true;
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        requestedFor.current = null;
        setState({ phase: "error", id: ingredientId, message: msg });
        done = true;
      }
    })();
    return () => {
      cancelled = true;
      if (!done) requestedFor.current = null;
    };
  }, [ingredientId]);

  if (!ingredientId || state.phase === "idle") return null;

  if (state.phase === "ready") {
    const { ingredient, parents } = state.data;
    return (
      <DetailPanel
        open={{ kind: "ingredient" }}
        onClose={onClose}
        ingredient={ingredient}
        items={[]}
        parents={parents}
        proposedName={null}
        proposedParent={null}
      />
    );
  }

  // Loading / error share the drawer scrim so the user has a Close
  // target even when the fetch fails. The scrim + close button here
  // mirror DetailPanel's own structure (kf-drawer / kf-drawer__close).
  const message =
    state.phase === "loading"
      ? "Loading ingredient..."
      : `Could not load ingredient: ${state.message}`;
  return (
    <>
      <div className="kf-drawer__backdrop" onClick={onClose} aria-hidden />
      <aside className="kf-drawer" role="dialog" aria-modal="true" aria-label="Ingredient details">
        <button type="button" className="kf-drawer__close" onClick={onClose} aria-label="Close">
          <span aria-hidden>&times;</span>
        </button>
        <div className="kf-drawer__head">
          <h3 className="kf-drawer__name">
            {state.phase === "loading" ? "Loading" : "Ingredient details"}
          </h3>
        </div>
        <div className="kf-drawer__block kf-dpn__block">
          <p className="kf-muted">{message}</p>
        </div>
      </aside>
    </>
  );
}
