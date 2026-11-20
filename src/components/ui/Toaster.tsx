"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, X as XIcon } from "lucide-react";

type ToastTone = "ink" | "block" | "good";
type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
  undo?: () => void | Promise<void>;
};

type Store = {
  current: Toast | null;
  listeners: Set<() => void>;
  nextId: number;
};

const store: Store = { current: null, listeners: new Set(), nextId: 1 };

function subscribe(fn: () => void) {
  store.listeners.add(fn);
  return () => {
    store.listeners.delete(fn);
  };
}
function getSnapshot(): Toast | null {
  return store.current;
}
function getServerSnapshot(): Toast | null {
  return null;
}
function emit() {
  for (const fn of store.listeners) fn();
}
function setCurrent(next: Toast | null) {
  store.current = next;
  emit();
}
function dismiss(id: number) {
  if (store.current?.id === id) setCurrent(null);
}

export function toast(
  message: string,
  options: { tone?: ToastTone; undo?: () => void | Promise<void> } = {}
) {
  if (typeof window === "undefined") return;
  setCurrent({
    id: store.nextId++,
    message,
    tone: options.tone ?? "ink",
    undo: options.undo,
  });
}

// Two live regions sit in the document from the first paint, empty. A toast
// with tone === "block" renders into the assertive region (role="alert");
// everything else goes into the polite region (role="status"). The regions
// are always present so a screen reader does not miss the first message.
export function Toaster() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const politeToast = current && current.tone !== "block" ? current : null;
  const alertToast = current && current.tone === "block" ? current : null;
  return (
    <div className="kf-toaster">
      <div className="kf-toaster__region" role="status" aria-live="polite">
        {politeToast ? <ToastView key={politeToast.id} toast={politeToast} /> : null}
      </div>
      <div className="kf-toaster__region" role="alert" aria-live="assertive">
        {alertToast ? <ToastView key={alertToast.id} toast={alertToast} /> : null}
      </div>
    </div>
  );
}

function ToastView({ toast: t }: { toast: Toast }) {
  const [undoing, setUndoing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const undoingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const remainingRef = useRef<number>(t.undo ? 10000 : 6000);
  const syncRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const paused = () => hoverRef.current || focusRef.current || undoingRef.current;
    const clear = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const sync = () => {
      if (paused()) {
        if (timerRef.current !== null && startedAtRef.current !== null) {
          remainingRef.current = Math.max(
            0,
            remainingRef.current - (Date.now() - startedAtRef.current)
          );
        }
        clear();
      } else if (timerRef.current === null && remainingRef.current > 0) {
        startedAtRef.current = Date.now();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          dismiss(t.id);
        }, remainingRef.current);
      }
    };
    syncRef.current = sync;

    const onEnter = () => {
      hoverRef.current = true;
      sync();
    };
    const onLeave = () => {
      hoverRef.current = false;
      sync();
    };
    const onFocusIn = () => {
      focusRef.current = true;
      sync();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (el.contains(e.relatedTarget as Node | null)) return;
      focusRef.current = false;
      sync();
    };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    sync();
    return () => {
      clear();
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [t.id]);

  useEffect(() => {
    undoingRef.current = undoing;
    syncRef.current();
  }, [undoing]);

  const toneClass =
    t.tone === "block" ? " kf-toast--block" : t.tone === "good" ? " kf-toast--good" : "";
  const runUndo = async () => {
    if (!t.undo) return;
    setUndoing(true);
    try {
      await t.undo();
      dismiss(t.id);
    } catch {
      toast("The undo did not finish. Check it before you go on.", { tone: "block" });
    } finally {
      setUndoing(false);
    }
  };
  return (
    <div className={`kf-toast${toneClass}`} ref={rootRef}>
      {t.tone === "good" ? <Check size={16} strokeWidth={2.5} aria-hidden /> : null}
      <span>{t.message}</span>
      {t.undo ? (
        <button
          type="button"
          className="kf-toast__undo"
          disabled={undoing}
          onClick={runUndo}
        >
          Undo
        </button>
      ) : null}
      <button
        type="button"
        className="kf-toast__x"
        aria-label="Dismiss"
        onClick={() => dismiss(t.id)}
      >
        <XIcon size={16} strokeWidth={2} aria-hidden />
      </button>
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
