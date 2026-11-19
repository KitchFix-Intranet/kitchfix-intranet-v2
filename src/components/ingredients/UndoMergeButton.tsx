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
import { postJson, saveErrorSentence } from "./panel/common";

export function UndoMergeButton({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function undo() {
    if (busy) return;
    setBusy(true);
    type Resp = { ok?: boolean; restoredItems?: number };
    const r = await postJson("/api/review/undo-merge", { sourceId });
    const data = (r.data ?? null) as Resp | null;
    if (!r.ok || !data?.ok) {
      toast(saveErrorSentence(r) ?? "Nothing was saved.", { tone: "block" });
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
