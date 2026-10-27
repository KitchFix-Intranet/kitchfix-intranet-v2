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
      try {
        const res = await fetch("/api/review/undo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId: id }),
        });
        if (res.ok) {
          ok += 1;
        } else {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          const msg = data?.error ?? `Undo ${res.status}`;
          if (/not confirmed/i.test(msg)) skipped += 1;
          else errors.push(msg);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
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
