"use client";

// Sends one confirmed vendor item back to the review queue from the
// Ingredients master drill-in. POSTs the existing owner-gated
// /api/review/undo with { itemId } - the same route the review
// queue's Undo uses. No new backend.
//
// undoConfirm keeps ingredient_id, so the item reappears in the queue
// still pointed at this master; the queue's own action bar (Relink /
// New ingredient / Keep separate) is where it then gets corrected.
// The golden link is soft-revoked, not deleted, so the matcher stops
// being trained on a confirmation Kevin has taken back.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";

export function RowSendBackButton({
  itemId,
  itemName,
}: {
  itemId: string;
  itemName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Send "${itemName}" back to the review queue?\n\n` +
        `The confirmed link is withdrawn and the item returns to the queue ` +
        `still pointed at this ingredient, where it can be relinked or split.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/review/undo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast(data?.error ?? `Send back failed (${res.status})`, { tone: "block" });
        setBusy(false);
        return;
      }
      toast("Sent back to review");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "block" });
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--line kf-btn--sm${busy ? " is-busy" : ""}`}
      disabled={busy}
      onClick={onClick}
      title="Withdraw this confirmation and send the item back to the review queue"
    >
      <Undo2 size={13} strokeWidth={1.5} aria-hidden />
      <span>Send back</span>
    </button>
  );
}
