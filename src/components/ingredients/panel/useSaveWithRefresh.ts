"use client";

// The one save path for the Stockpot lane. Every save in list A of
// train 2's Part 1 report reaches the server through this hook so the
// save rule holds across editors, row buttons and long jobs:
//
//   - the control always comes back (no more "Saving..." for good);
//   - what was typed stays (the editor does not unmount on failure);
//   - words beside the control say what did not happen, from one
//     vocabulary in panel/common.ts::saveErrorSentence;
//   - no status numbers and no code names on the page;
//   - no block toast for a failure whose control is still on the page
//     (the caller renders the sentence in place);
//   - a second press while saving does nothing;
//   - trying again works from the same open editor.
//
// Long jobs (matcher, intake, backfills, the one-time migrate) pass
// `timeoutMs: null` into their op so the 30 s timeout does not apply.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { saveErrorSentence, type SaveOutcome } from "./common";

type SaveOp = () => Promise<SaveOutcome>;

export type SaveOptions = {
  op: SaveOp;
  // Fired once the refreshed data has rendered. String or a function
  // of the response body (merge, create, etc. all read a count out of
  // the server echo).
  successMessage: string | ((data: unknown) => string);
  // Legacy prop from the pre-T2 helper. T2 §1 replaces the per-site
  // "Save failed (status)" fallback with one vocabulary in
  // panel/common.ts::saveErrorSentence; accepting the field keeps old
  // callers compiling while the sentence is ignored.
  errorFallback?: string;
  // Caller's existing onDone (the panel's refresh invalidator; etc.).
  // Fired AFTER ok but BEFORE the transition so the refresh picks up
  // the write.
  onDone?: () => void;
  // Optional side effect run on success BEFORE the refresh (e.g.
  // dropParents() after a create/rename/merge).
  onAfterSuccess?: (data: unknown) => void;
  // Optional success tone.
  toastTone?: "good" | "block" | "ink";
  // Escape hatch when the success toast carries Undo or other options
  // the plain-string API cannot express.
  fireSuccessToast?: (data: unknown, message: string) => void;
};

export function useSaveWithRefresh() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyLocal, setBusyLocal] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      // Rule: "A second press while saving does nothing." The hook's
      // own `busy` already disables the control; this guard catches a
      // race where a caller races two save() calls without reading
      // busy.
      if (busyLocal || isPending) return { ok: false, data: null };
      setBusyLocal(true);
      setError(null);
      const r = await opts.op();
      if (!r.ok) {
        const msg = saveErrorSentence(r) ?? "Nothing was saved.";
        setError(msg);
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
    [router, busyLocal, isPending]
  );

  return {
    save,
    busy: busyLocal || isPending,
    savedAt,
    error,
    // Callers whose Cancel resets a draft also want to clear the
    // in-place error without firing a save.
    clearError: () => setError(null),
  };
}
