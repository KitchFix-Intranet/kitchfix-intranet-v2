"use client";

// Item grade (Standard / Premium) segmented control. Lifted verbatim
// from DetailPanel.tsx in N7 commit 0.

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
    <section className="kf-drawer__block kf-dpn__block" aria-label="Grade">
      <header className="kf-drawer__block-head">
        <h4>Grade</h4>
        <small>
          Quality tier of this vendor item. Standard is the default.
          Premium names a dearer sourcing (Coleman, Bell &amp; Evans,
          prime grade, etc.) so the master's rollup can separate the
          two.
        </small>
      </header>
      <div className="kf-grade">
        <div className="kf-grade__ctl" role="radiogroup" aria-label="Item grade">
          <button
            type="button"
            role="radio"
            aria-checked={current === "standard"}
            aria-pressed={current === "standard"}
            className={`kf-grade__btn${current === "standard" ? " kf-grade__btn--on" : ""}`}
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
            className={`kf-grade__btn kf-grade__btn--premium${current === "premium" ? " kf-grade__btn--on" : ""}`}
            onClick={() => setGrade("premium")}
            disabled={busy}
          >
            Premium
          </button>
          <SaveFlash savedAt={savedAt} error={error} />
        </div>
        <div className="kf-dpn__hint">
          Grade is a property of this vendor item, not its ingredient.
          A master can hold a mix - the detail pane rolls up blended,
          standard and premium prices separately.
        </div>
      </div>
    </section>
  );
}

