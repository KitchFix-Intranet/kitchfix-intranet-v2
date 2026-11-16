"use client";

// T4 §3: one shared helper so "Saved" and the new number arrive
// together. Before T4 every save called `toast("Saved")` then
// `onDone()` -> `router.refresh()`; the toast fired immediately, the
// number moved about 1.6s later. The pattern below keeps the control
// in its busy state until the refreshed server data has rendered, and
// fires the success toast at that moment.
//
// Pattern:
//   const { save, busy, savedAt, error } = useSaveWithRefresh();
//   await save({
//     op: () => postJson("/api/review/set-grade", { itemId, grade }),
//     successMessage: "Saved: grade",
//     onDone,                        // invalidate upstream (ItemPanelById re-fetch)
//     onAfterSuccess: dropParents,   // optional side effect (cache drop)
//   });
//
// `busy` combines the local in-flight flag AND useTransition's
// isPending so the primary stays "Saving..." through both the POST
// and the refresh. `savedAt` and `error` feed <SaveFlash /> unchanged.
//
// Error path releases the control immediately with the error toast
// (same contract the old code had).

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";

// The POST returns an unknown body; callers that need a shape cast it
// in the two callbacks (successMessage, onAfterSuccess, fireSuccessToast)
// the same way the old inline saves did. No new unsafe casts in the
// hook itself.
type SaveOp = () => Promise<{ ok: boolean; status: number; data: unknown }>;

export type SaveOptions = {
  op: SaveOp;
  // Message to toast once the refreshed data has rendered. String or
  // a function of the response body (same options the old inline
  // toast() calls had). Ignored when `fireSuccessToast` is supplied.
  successMessage: string | ((data: unknown) => string);
  // Fallback error text when the server body does not carry one. The
  // hook still appends the HTTP status when it fires the fallback.
  errorFallback?: string;
  // Caller's existing onDone (ItemPanelById's invalidate; DetailPanel's
  // router.refresh() passthrough; etc.). Fired AFTER the POST ok but
  // BEFORE the transition - so the refresh picks up the write.
  onDone?: () => void;
  // Optional side effect run on success BEFORE the refresh starts
  // (e.g. dropParents() after a create/rename/merge).
  onAfterSuccess?: (data: unknown) => void;
  // Optional toast tone override for success.
  toastTone?: "good" | "block" | "ink";
  // Optional escape hatch for callers whose success toast carries
  // options the simple string API cannot express (merge: undo).
  // When provided, the hook calls this at the moment the refreshed
  // data has rendered instead of firing its own toast; the plain
  // `successMessage` is still used as a stable fallback string so
  // the caller does not have to rebuild it inside the callback.
  fireSuccessToast?: (data: unknown, message: string) => void;
};

function errMsg(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return fallback;
}

export function useSaveWithRefresh() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyLocal, setBusyLocal] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Toast queue: when a save succeeds we set `pendingToast` + start the
  // refresh transition. The effect below watches `isPending` and, when
  // it goes from true back to false, fires the toast + stamps savedAt
  // + releases the control. That is the moment the new server data
  // has rendered into the tree - the user sees the toast and the new
  // number together.
  const pendingToast = useRef<{
    message: string;
    tone?: "good" | "block" | "ink";
    fire?: () => void;
  } | null>(null);
  const prevPending = useRef(false);

  useEffect(() => {
    if (prevPending.current && !isPending) {
      const p = pendingToast.current;
      if (p) {
        if (p.fire) p.fire();
        else toast(p.message, p.tone ? { tone: p.tone } : undefined);
        pendingToast.current = null;
        setSavedAt(Date.now());
        setBusyLocal(false);
      }
    }
    prevPending.current = isPending;
  }, [isPending]);

  const save = useCallback(
    async (opts: SaveOptions): Promise<{ ok: boolean; data: unknown }> => {
      setBusyLocal(true);
      setError(null);
      const r = await opts.op();
      if (!r.ok) {
        const msg = errMsg(r.data, opts.errorFallback ?? `Save failed (${r.status})`);
        setError(msg);
        toast(msg, { tone: "block" });
        setBusyLocal(false);
        return { ok: false, data: null };
      }
      const successMsg =
        typeof opts.successMessage === "function"
          ? opts.successMessage(r.data)
          : opts.successMessage;
      const fireCustom = opts.fireSuccessToast;
      pendingToast.current = {
        message: successMsg,
        tone: opts.toastTone,
        fire: fireCustom ? () => fireCustom(r.data, successMsg) : undefined,
      };
      if (opts.onAfterSuccess) opts.onAfterSuccess(r.data);
      if (opts.onDone) opts.onDone();
      startTransition(() => {
        router.refresh();
      });
      return { ok: true, data: r.data };
    },
    [router],
  );

  return {
    save,
    busy: busyLocal || isPending,
    savedAt,
    error,
    // Exposed so blocks that need a manual error reset (Cancel) can
    // clear it without a save.
    clearError: () => setError(null),
  };
}
