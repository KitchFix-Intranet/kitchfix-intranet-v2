"use client";

// T4 §2a: one in-memory cache for the full active-ingredient list
// (used by Merge + Sub-category pickers on the Ingredients tab and the
// drawer opened from it). Fetched the first time ANY panel surface asks
// for it; held for the life of the page (SPA session). Dropped after a
// create / rename / merge / undo-merge succeeds so the next ask picks
// up the server's new truth.
//
// Reads from /api/review/ingredient (route we already have). That
// route needs an id - we pass any stable id (the first master the
// Ingredients tab happens to have in view). Callers that have no id
// handy fall through to an empty list on failure; the Merge row's
// own loading / error states render against the error.
//
// Not a React context: the pickers that need this are not all under
// one subtree (drawer + detail pane are siblings), and a module-level
// store survives their mount/unmount.

import type { ReviewCardIngredient } from "./itemTypes";

let cached: ReviewCardIngredient[] | null = null;
let inflight: Promise<ReviewCardIngredient[]> | null = null;

export async function loadParents(
  anyIngredientId: string,
): Promise<ReviewCardIngredient[]> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(
      `/api/review/ingredient?id=${encodeURIComponent(anyIngredientId)}`,
    );
    if (!res.ok) {
      inflight = null;
      throw new Error(`fetch failed (${res.status})`);
    }
    const data = (await res.json()) as { parents?: ReviewCardIngredient[] };
    const list = data.parents ?? [];
    cached = list;
    inflight = null;
    return list;
  })();
  return inflight;
}

// Drop the cache. Call from the panel's save flows that change the
// active-ingredient set shape (create, rename, merge, undo-merge).
export function dropParents(): void {
  cached = null;
  inflight = null;
}

// Test / dev helper: whether the cache is warm. No consumer outside
// this module today - exported for timing probes.
export function hasCachedParents(): boolean {
  return cached != null;
}
