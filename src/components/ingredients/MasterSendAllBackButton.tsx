"use client";

// Sends every confirmed item under one master back to the review
// queue in a single call. POSTs the owner-gated /api/review/undo with
// { itemIds } - the plural shape every other review action already
// uses. No new backend beyond the route accepting an array.
//
// The intended workflow for a mixed master: dissolve it here, then
// re-sort in the review queue, where multi-select and the full action
// bar (Confirm / Relink / New ingredient / Keep separate) already live.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";

export function MasterSendAllBackButton({
  masterName,
  itemIds,
}: {
  masterName: string;
  itemIds: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (itemIds.length === 0) return null;

  async function onClick() {
    if (busy) return;
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Send all ${itemIds.length} items back to the review queue?\n\n` +
        `"${masterName}" will have no linked items left. They return to the ` +
        `queue grouped under it, where they can be confirmed, relinked or ` +
        `split into a new ingredient.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/review/undo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; undone?: number; skipped?: number; errors?: string[] }
        | null;
      if (!res.ok) {
        toast(data?.error ?? `Send back failed (${res.status})`, { tone: "block" });
        setBusy(false);
        return;
      }
      const undone = data?.undone ?? itemIds.length;
      const failed = data?.errors?.length ?? 0;
      toast(
        failed > 0
          ? `Sent ${undone} back; ${failed} failed`
          : `Sent ${undone} back to review`,
        failed > 0 ? { tone: "block" } : undefined
      );
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
      title={`Withdraw all ${itemIds.length} confirmations and send them back to the review queue`}
    >
      <Undo2 size={13} strokeWidth={1.5} aria-hidden />
      <span>Send all {itemIds.length} back</span>
    </button>
  );
}
