"use client";

// T2 §3 + round 2 §4: scoped "has typed work" registry. Each panel
// provides a scope via <DirtyScopeProvider>; editors inside call
// `useDirtyEditor(id, dirty, discard)` and pick up the scope through
// context. An editor rendered outside any provider is a no-op (the
// Ingredients-tab drill-in uses the same blocks and must never flip
// the item panel's Discard ask on close).
//
// Entries are held in refs + a module-level Map keyed by scope, so a
// dirty flip does not cascade re-renders through the panel. Closing
// one panel never touches another panel's registry because each
// panel has its own scope key.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

type Entry = {
  dirtyRef: { current: boolean };
  discardRef: { current: () => void };
};

const scopes = new Map<string, Map<string, Entry>>();

function getScopeMap(scope: string): Map<string, Entry> {
  let m = scopes.get(scope);
  if (!m) {
    m = new Map();
    scopes.set(scope, m);
  }
  return m;
}

const ScopeContext = createContext<string | null>(null);

export function DirtyScopeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function anyDirty(scope: string): boolean {
  const m = scopes.get(scope);
  if (!m) return false;
  for (const e of m.values()) if (e.dirtyRef.current) return true;
  return false;
}

export function discardAll(scope: string): void {
  const m = scopes.get(scope);
  if (!m) return;
  for (const e of m.values()) {
    try {
      e.discardRef.current();
    } catch {
      // A broken discard is not a reason to leave the user stuck.
    }
  }
}

// Hook for editors with a typed field. Pass a stable id (unique
// inside its scope), the current dirty flag, and a reset-to-baseline
// function. Outside any <DirtyScopeProvider> this is a no-op - the
// editor is not inside a panel that cares. Callers that cannot sit
// inside the provider (e.g. ReviewActions, which owns the sub-panel
// state but renders ReviewCardPanelShell as a child) may pass an
// explicit `scope` to override the context value.
export function useDirtyEditor(id: string, dirty: boolean, discard: () => void, explicitScope?: string) {
  const contextScope = useContext(ScopeContext);
  const scope = explicitScope ?? contextScope;
  const dirtyRef = useRef(dirty);
  const discardRef = useRef(discard);
  dirtyRef.current = dirty;
  discardRef.current = discard;
  useEffect(() => {
    if (!scope) return;
    const m = getScopeMap(scope);
    m.set(id, { dirtyRef, discardRef });
    return () => {
      m.delete(id);
      // Garbage-collect the scope map once empty so a next session
      // starts clean and the top-level `scopes` map does not grow
      // without bound across hot-reloads.
      if (m.size === 0) scopes.delete(scope);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, id]);
}
