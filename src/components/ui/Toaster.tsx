"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type ToastTone = "ink" | "block";
type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
  undo?: () => void | Promise<void>;
};

type Store = {
  toasts: Toast[];
  listeners: Set<() => void>;
  nextId: number;
};

const store: Store = { toasts: [], listeners: new Set(), nextId: 1 };

function subscribe(fn: () => void) {
  store.listeners.add(fn);
  return () => {
    store.listeners.delete(fn);
  };
}
function getSnapshot() {
  return store.toasts;
}
function emit() {
  for (const fn of store.listeners) fn();
}
function push(t: Toast) {
  store.toasts = [...store.toasts, t];
  emit();
  const id = t.id;
  window.setTimeout(() => {
    store.toasts = store.toasts.filter((x) => x.id !== id);
    emit();
  }, 6000);
}

export function toast(
  message: string,
  options: { tone?: ToastTone; undo?: () => void | Promise<void> } = {}
) {
  if (typeof window === "undefined") return;
  push({
    id: store.nextId++,
    message,
    tone: options.tone ?? "ink",
    undo: options.undo,
  });
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, () => [] as Toast[]);
  if (toasts.length === 0) return null;
  return (
    <div className="kf-toaster" aria-live="polite" role="status">
      {toasts.map((t) => (
        <ToastView
          key={t.id}
          toast={t}
          onDismiss={() => {
            store.toasts = store.toasts.filter((x) => x.id !== t.id);
            emit();
          }}
        />
      ))}
    </div>
  );
}

function ToastView({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`kf-toast${t.tone === "block" ? " kf-toast--block" : ""}`}>
      <span>{t.message}</span>
      {t.undo ? (
        <button
          type="button"
          className="kf-toast__undo"
          disabled={busy}
          onClick={async () => {
            try {
              setBusy(true);
              await t.undo?.();
            } finally {
              onDismiss();
            }
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

export function useRevealedOnce(pathname: string): boolean {
  // Returns true if this route has already been revealed in this session.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    try {
      const key = `kf.revealed:${pathname}`;
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const isBF = nav?.type === "back_forward";
      if (isBF || sessionStorage.getItem(key)) {
        setRevealed(true);
      } else {
        sessionStorage.setItem(key, "1");
      }
    } catch {
      // private mode etc. - just show the animation
    }
  }, [pathname]);
  return revealed;
}
