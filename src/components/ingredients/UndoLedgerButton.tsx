"use client";

// Loops /api/review/undo for every item_id in a confirm event. One confirm
// -> one Undo click -> N POSTs. We don't fail the batch on a single-item
// error - the user clicked Undo on the whole decision; we try everything
// and report the aggregate.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import { postJson, errMsg, saveErrorSentence } from "./panel/common";

type Props = {
  itemIds: string[];
  label?: string;
};

export function UndoLedgerButton({ itemIds, label = "Undo" }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function undoAll() {
    if (busy || itemIds.length === 0) return;
    setBusy(true);
    let ok = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const id of itemIds) {
      const r = await postJson("/api/review/undo", { itemId: id });
      if (r.ok) {
        ok += 1;
      } else {
        // Match the "already undone" case on the explicit server
        // reason only; a dropped connection or 5xx goes into errors
        // with the plain sentence.
        const explicit = errMsg(r.data, "");
        if (r.kind === "refused" && /not confirmed/i.test(explicit)) {
          skipped += 1;
        } else {
          errors.push(saveErrorSentence(r) ?? "Nothing was saved.");
        }
      }
    }
    if (errors.length > 0) {
      toast(errors[0], { tone: "block" });
    } else if (ok === 0 && skipped > 0) {
      toast("Already undone");
    } else {
      const skippedNote = skipped > 0 ? ` (${fmtCount(skipped)} were already undone)` : "";
      toast(`Undid ${fmtCount(ok)} items${skippedNote}`);
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--ghost kf-btn--sm${busy ? " is-busy" : ""}`}
      onClick={undoAll}
      disabled={busy || itemIds.length === 0}
      title="Revert this confirm"
    >
      <Undo2 size={14} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  );
}
