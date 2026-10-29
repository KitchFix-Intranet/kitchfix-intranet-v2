"use client";

// Single-item unflag (resolve) for the Overview flagged panel. POSTs
// /api/review/flag with { itemIds: [id], flagged: false } which
// clears flag_note / flagged_by / flagged_at on that row. Mirrors
// the UndoLedgerButton shape.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";

export function UnflagButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unflag() {
    if (busy) return;
    setBusy(true);
    type Resp = { marked?: number; error?: string };
    let data: Resp | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/review/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIds: [itemId], flagged: false }),
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as Resp | null;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "block" });
      setBusy(false);
      return;
    }
    if (status < 200 || status >= 300) {
      toast(data?.error ?? `Unflag failed (${status})`, { tone: "block" });
      setBusy(false);
      return;
    }
    toast("Unflagged");
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--ghost kf-btn--sm${busy ? " is-busy" : ""}`}
      disabled={busy}
      onClick={unflag}
      title="Clear the flag on this item"
    >
      <X size={14} strokeWidth={1.5} />
      <span>{busy ? "Saving..." : "Unflag"}</span>
    </button>
  );
}
