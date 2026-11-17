"use client";

// T2 §3: shared "has typed work" registry for the DetailPanel. Each
// editor with a typed field calls `useDirtyEditor(id, dirty, discard)`
// at mount; the panel reads `anyDirty()` on Esc, close-button and
// backdrop click and raises an in-page "Discard what you typed?"
// (Keep editing / Discard) ask when anything is dirty.
//
// The registry is module-level because only one DetailPanel is open at
// a time; this keeps the hook free of context plumbing and avoids
// re-rendering the whole panel on every dirty flip.

import { useEffect, useRef } from "react";

type Entry = {
  dirtyRef: { current: boolean };
  discardRef: { current: () => void };
};

const entries = new Map<string, Entry>();

export function anyDirty(): boolean {
  for (const e of entries.values()) if (e.dirtyRef.current) return true;
  return false;
}

export function discardAll(): void {
  for (const e of entries.values()) {
    try {
      e.discardRef.current();
    } catch {
      // A broken discard is not a reason to leave the user stuck.
    }
  }
}

// Clear every registered editor without calling its discard. Used by
// the panel on close so the next open starts clean even if the browser
// held onto a stale effect cleanup.
export function clearAll(): void {
  entries.clear();
}

// Hook for editors with a typed field. Pass a stable id (unique to
// this editor instance), the current dirty flag, and a reset-to-
// baseline function. The flag is tracked via a ref so a dirty flip
// never re-registers.
export function useDirtyEditor(id: string, dirty: boolean, discard: () => void) {
  const dirtyRef = useRef(dirty);
  const discardRef = useRef(discard);
  dirtyRef.current = dirty;
  discardRef.current = discard;
  useEffect(() => {
    entries.set(id, { dirtyRef, discardRef });
    return () => {
      entries.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
