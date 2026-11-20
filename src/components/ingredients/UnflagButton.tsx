"use client";

// Single-item unflag (resolve) for the Overview flagged panel. POSTs
// /api/review/flag with { itemIds: [id], flagged: false } which
// clears flag_note / flagged_by / flagged_at on that row. Mirrors
// the UndoLedgerButton shape.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { postJson, saveErrorSentence } from "./panel/common";

export function UnflagButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unflag() {
    if (busy) return;
    setBusy(true);
    const r = await postJson("/api/review/flag", { itemIds: [itemId], flagged: false });
    if (!r.ok) {
      toast(saveErrorSentence(r) ?? "Nothing was saved.", { tone: "block" });
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
