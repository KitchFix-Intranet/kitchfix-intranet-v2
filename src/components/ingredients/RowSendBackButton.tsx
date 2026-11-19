"use client";

// Sends one confirmed vendor item back to the review queue from the
// Ingredients master drill-in. POSTs the existing owner-gated
// /api/review/undo with { itemId } - the same route the review
// queue's Undo uses. No new backend.
//
// T2 §5: the former window.confirm is replaced by an in-page
// "What happens" ask. Esc closes the ask; no typed field so no
// Discard needed.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { postJson, saveErrorSentence } from "./panel/common";

export function RowSendBackButton({
  itemId,
  itemName,
}: {
  itemId: string;
  itemName: string;
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

  async function sendBack() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/undo", { itemId });
    if (!r.ok) {
      setError(saveErrorSentence(r) ?? "Nothing was saved.");
      setBusy(false);
      return;
    }
    toast("Sent back to review", { tone: "good" });
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
        title="Withdraw this confirmation and send the item back to the review queue"
      >
        Send back
      </button>
    );
  }
  return (
    <div className="kf-ing-ask" role="group" aria-label="Confirm send back">
      <p className="kf-ing-ask__body">
        Send &ldquo;{itemName}&rdquo; back to the review queue. The confirmed link is
        withdrawn and the item returns to the queue still pointed at this ingredient,
        where it can be relinked or split.
      </p>
      <div className="kf-ing-ask__actions">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy}
          onClick={sendBack}
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
