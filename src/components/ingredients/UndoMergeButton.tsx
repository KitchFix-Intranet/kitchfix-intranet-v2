"use client";

// Posts to /api/review/undo-merge for a single sourceId. The server
// reads the merge event's moved-item list and sends items back to the
// source; the alias gets soft-revoked. Mirrors UndoLedgerButton's
// shape for consistency.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

export function UndoMergeButton({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function undo() {
    if (busy) return;
    setBusy(true);
    type Resp = { ok?: boolean; error?: string; restoredItems?: number };
    let data: Resp | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/review/undo-merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as Resp | null;
      if (!res.ok || !data?.ok) {
        toast(data?.error ?? `Undo ${status}`, { tone: "block" });
        setBusy(false);
        return;
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`Merge undone - ${fmtCount(data?.restoredItems ?? 0)} items restored`);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--ghost kf-btn--sm${busy ? " is-busy" : ""}`}
      onClick={undo}
      disabled={busy}
      title="Reverse this merge"
    >
      <Undo2 size={14} strokeWidth={1.5} />
      <span>Undo</span>
    </button>
  );
}
