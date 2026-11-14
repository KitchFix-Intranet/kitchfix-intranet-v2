"use client";

// N8 §1g: Grade - segmented control (Standard / Premium) in the shared
// .kf-ipanel__seg chrome. No section header, no hint paragraph; the
// row that hosts this already labels it.
//
// T4 §3: save-and-refresh helper. The primary stays "Saving..." until
// the refreshed server data has rendered, and the success toast fires
// at that moment. No optimistic client state - the segmented control's
// current value is still read straight from item.grade, which router
// .refresh() replaces with the new truth.

import type { ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson } from "./common";
import { useSaveWithRefresh } from "./useSaveWithRefresh";

export function ItemGradeBlock({
  item,
  onDone,
}: {
  item: ReviewGroupItem;
  onDone: () => void;
}) {
  const current: "standard" | "premium" = item.grade === "premium" ? "premium" : "standard";
  const { save, busy, savedAt, error } = useSaveWithRefresh();

  async function setGrade(next: "standard" | "premium") {
    if (busy || next === current) return;
    await save({
      op: () =>
        postJson("/api/review/set-grade", {
          itemId: item.id,
          grade: next === "premium" ? "premium" : null,
        }),
      successMessage: next === "premium" ? "Marked premium" : "Cleared to standard",
      toastTone: "good",
      onDone,
    });
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
