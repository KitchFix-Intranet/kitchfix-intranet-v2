"use client";

// T4 §3: one Undo button for every T4 decision. Calls /api/review/undo
// with the event id and lets undoDecisionEvent apply the snapshot.
// When the item has moved on, the server returns the plain sentence
// and the toaster shows it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { postJson, errMsg, saveErrorSentence } from "./panel/common";

export function UndoDecisionButton({ eventId, label = "Undo" }: { eventId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setBusy(true);
    const r = await postJson("/api/review/undo", { eventId });
    if (!r.ok) {
      // Show the server's own sentence when present; otherwise fall
      // back to the generic one.
      const explicit = errMsg(r.data, "");
      toast(explicit || saveErrorSentence(r) || "Nothing was undone.", { tone: "block" });
      setBusy(false);
      return;
    }
    const d = (r.data ?? {}) as { reverted?: number; refused?: number };
    const reverted = Number(d.reverted ?? 0);
    const refused = Number(d.refused ?? 0);
    if (reverted === 0 && refused > 0) {
      toast("This item was changed again since. Nothing was undone.", { tone: "block" });
    } else if (reverted > 0 && refused > 0) {
      toast(`Undone (${refused} items were changed again and skipped).`);
    } else {
      toast("Undone");
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--ghost kf-btn--sm${busy ? " is-busy" : ""}`}
      onClick={go}
      disabled={busy}
      title="Take this decision back"
    >
      <Undo2 size={14} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  );
}
