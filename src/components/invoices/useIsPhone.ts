"use client";

// A tiny hook for Capture's phone branches that need React-level
// decisions (e.g. wrapping a block in a Sheet on phone but inline on
// desk). The breakpoint is 860 px, DESIGN §3's phone threshold.

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 860px)";

function subscribe(fn: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  // Server-safe default: desk. The CSS branching renders both and
  // hides one; the React branches that depend on isPhone (D6 sheets,
  // the action bar) land in a useEffect so the SSR output is stable.
  return false;
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
