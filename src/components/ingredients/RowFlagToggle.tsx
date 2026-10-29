"use client";

// Per-row flag/unflag toggle for the review queue. One inline
// icon-button on every item row: when the item is unflagged it flags
// just that item (optional short note via prompt); when it's flagged
// it clears the flag. POSTs the existing owner-gated /api/review/flag
// with { itemIds:[id], flagged } - the same route the group Flag
// button and the Overview UnflagButton use. No new backend.
// Orthogonal to disposition: never touches link_status / status /
// ingredient_id.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flag } from "lucide-react";
import { toast } from "@/components/ui/Toaster";

export function RowFlagToggle({
  itemId,
  flagged,
  flagNote,
  flaggedBy,
}: {
  itemId: string;
  flagged: boolean;
  flagNote?: string | null;
  flaggedBy?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function post(
    body: unknown
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const res = await fetch("/api/review/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: res.ok, status: res.status, error: data?.error };
    } catch (e) {
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function onClick() {
    if (busy) return;
    if (!flagged) {
      // Flagging: optional short note, same shape as the group Flag button.
      // eslint-disable-next-line no-alert
      const note = window.prompt("Flag this item for a second look. Optional note:", "");
      if (note === null) return; // cancelled
      setBusy(true);
      const r = await post({ itemIds: [itemId], flagged: true, note: note.trim() || null });
      if (!r.ok) {
        toast(r.error ?? `Flag failed (${r.status})`, { tone: "block" });
        setBusy(false);
        return;
      }
      toast("Flagged for review");
    } else {
      // Unflag / resolve.
      setBusy(true);
      const r = await post({ itemIds: [itemId], flagged: false });
      if (!r.ok) {
        toast(r.error ?? `Unflag failed (${r.status})`, { tone: "block" });
        setBusy(false);
        return;
      }
      toast("Unflagged");
    }
    setBusy(false);
    router.refresh();
  }

  const title = flagged
    ? (flagNote ? `Flagged: ${flagNote}` : "Flagged for review") +
      (flaggedBy ? ` - ${flaggedBy}` : "") +
      " - click to clear"
    : "Flag this item for a second look";

  return (
    <button
      type="button"
      className={`kf-rvc__flagbtn${flagged ? " kf-rvc__flagbtn--on" : ""}${busy ? " is-busy" : ""}`}
      disabled={busy}
      onClick={onClick}
      title={title}
      aria-pressed={flagged}
      aria-label={flagged ? "Unflag this item" : "Flag this item for review"}
    >
      <Flag size={14} strokeWidth={1.5} aria-hidden />
    </button>
  );
}
