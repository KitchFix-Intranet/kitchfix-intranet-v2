"use client";

// N8 §1g: Grade - segmented control (Standard / Premium) in the shared
// .kf-ipanel__seg chrome. No section header, no hint paragraph; the
// row that hosts this already labels it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import type { ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";

export function ItemGradeBlock({
  item,
  onDone,
}: {
  item: ReviewGroupItem;
  onDone: () => void;
}) {
  const router = useRouter();
  const current: "standard" | "premium" = item.grade === "premium" ? "premium" : "standard";
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setGrade(next: "standard" | "premium") {
    if (busy || next === current) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-grade", {
      itemId: item.id,
      grade: next === "premium" ? "premium" : null,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    toast(next === "premium" ? "Marked premium" : "Cleared to standard", { tone: "good" });
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
    router.refresh();
  }

  return (
    <div className="kf-ipanel__row-value-flex" aria-label="Grade">
      <div className="kf-ipanel__seg" role="radiogroup" aria-label="Item grade">
        <button
          type="button"
          role="radio"
          aria-checked={current === "standard"}
          aria-pressed={current === "standard"}
          className="kf-ipanel__seg-btn"
          onClick={() => setGrade("standard")}
          disabled={busy}
        >
          Standard
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={current === "premium"}
          aria-pressed={current === "premium"}
          className="kf-ipanel__seg-btn"
          onClick={() => setGrade("premium")}
          disabled={busy}
        >
          Premium
        </button>
      </div>
      <SaveFlash savedAt={savedAt} error={error} />
    </div>
  );
}
