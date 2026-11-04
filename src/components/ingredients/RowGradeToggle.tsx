"use client";

// G3 (grade control reachability): the G1 ItemGradeBlock was defined
// but never mounted - two builds shipped a setter nobody could reach.
// This row-level toggle makes grade settable directly from the
// linked-vendor-items table in the master detail pane, where a human
// is already looking when they think "that one's the premium bird."
//
// Standard shows a muted pill reading "Standard"; premium shows the
// amber pill from G1 (.kf-pill--premium register). Both states ARE
// the control; one click flips. Writes through the existing G1 path
// (POST /api/review/set-grade -> setVendorItemGrade); one pr_events
// row with before + after populated (ledger covers undo).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";

export function RowGradeToggle({
  itemId,
  grade,
}: {
  itemId: string;
  // Raw grade column value. Null, "" and any non-"premium" string read
  // as Standard. Mirrors the server-side rule in setVendorItemGrade.
  grade: string | null;
}) {
  const router = useRouter();
  const current: "standard" | "premium" = grade === "premium" ? "premium" : "standard";
  const next: "standard" | "premium" = current === "premium" ? "standard" : "premium";
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/review/set-grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          // Server narrows to the sanctioned two-value space.
          grade: next === "premium" ? "premium" : null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast(data?.error ?? `Save failed (${res.status})`, { tone: "block" });
        setBusy(false);
        return;
      }
      toast(next === "premium" ? "Marked premium" : "Cleared to standard", { tone: "good" });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "block" });
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  }

  const label = current === "premium" ? "Premium" : "Standard";
  const cls =
    current === "premium"
      ? "kf-grade-row kf-grade-row--premium"
      : "kf-grade-row kf-grade-row--standard";
  const title =
    next === "premium"
      ? "Mark this item as Premium tier"
      : "Clear this item back to Standard tier";

  return (
    <button
      type="button"
      className={`${cls}${busy ? " is-busy" : ""}`}
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={`Grade: ${label}. Click to change to ${next}.`}
    >
      {label}
    </button>
  );
}
