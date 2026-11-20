"use client";

// Sends every confirmed item under one master back to the review
// queue in a single call. POSTs the owner-gated /api/review/undo with
// { itemIds } - the plural shape every other review action already
// uses. No new backend beyond the route accepting an array.
//
// T2 §5: the former window.confirm box is replaced by an in-page
// "What happens" ask that drops down from the button. The ask is one
// sentence of what will change, then a primary action + Cancel.
// Esc on the ask closes it (no typed field, so no Discard needed).

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { postJson, saveErrorSentence } from "./panel/common";

export function MasterSendAllBackButton({
  masterName,
  itemIds,
}: {
  masterName: string;
  itemIds: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!askOpen) return;
    cancelBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        setAskOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [askOpen, busy]);

  if (itemIds.length === 0) return null;

  async function sendAll() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/undo", { itemIds });
    const data = (r.data ?? null) as
      | { undone?: number; skipped?: number; errors?: string[] }
      | null;
    if (!r.ok) {
      setError(saveErrorSentence(r) ?? "Nothing was saved.");
      setBusy(false);
      return;
    }
    const undone = data?.undone ?? itemIds.length;
    const failed = data?.errors?.length ?? 0;
    toast(
      failed > 0
        ? `Sent ${undone} back; ${failed} failed`
        : `Sent ${undone} back to review`,
      failed > 0 ? { tone: "block" } : { tone: "good" }
    );
    setBusy(false);
    setAskOpen(false);
    router.refresh();
  }

  if (!askOpen) {
    return (
      <button
        type="button"
        className={`kf-btn kf-btn--line kf-btn--sm${busy ? " is-busy" : ""}`}
        disabled={busy}
        onClick={() => setAskOpen(true)}
        title={`Withdraw all ${itemIds.length} confirmations and send them back to the review queue`}
      >
        <Undo2 size={13} strokeWidth={1.5} aria-hidden />
        <span>Send all {itemIds.length} back</span>
      </button>
    );
  }
  return (
    <div className="kf-ing-ask" role="group" aria-label="Confirm send back">
      <p className="kf-ing-ask__body">
        Send all {itemIds.length} items under &ldquo;{masterName}&rdquo; back to the review queue.
        They return grouped, where they can be confirmed, relinked or split into a new ingredient.
      </p>
      <div className="kf-ing-ask__actions">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy}
          onClick={sendAll}
        >
          {busy ? "Saving..." : "Send back"}
        </button>
        <button
          ref={cancelBtnRef}
          type="button"
          className="kf-btn kf-btn--line kf-btn--sm"
          disabled={busy}
          onClick={() => setAskOpen(false)}
        >
          Cancel
        </button>
        {error ? (
          <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
