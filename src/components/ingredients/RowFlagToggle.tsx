"use client";

// Per-row flag/unflag toggle for the review queue. T2 §5: the former
// window.prompt is replaced by an in-row note field. Click Flag ->
// the small form opens; the note is optional; Save posts, Cancel
// closes the form. Esc inside the form closes it; the note is typed
// work so a changed value registers with the panel's Discard ask
// when the row is inside a panel.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Flag } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { nameFromEmail } from "@/lib/fmt";
import { postJson, saveErrorSentence } from "./panel/common";

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
  const [formOpen, setFormOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // T4 §6: when the note has text, Esc / Cancel ask before dropping.
  // Scoped to this row so the item panel's dirty registry never fires.
  const [discardAsk, setDiscardAsk] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // T2 round 2 §4: the flag note is not inside any panel's save
  // boundary (it sits on a review-card row). It does not register
  // with the dirty registry so it never flips the item panel's
  // Discard ask. A row-local Esc closes the form in-place.

  useEffect(() => {
    if (!formOpen) return;
    inputRef.current?.focus();
  }, [formOpen]);

  async function saveFlag() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/flag", {
      itemIds: [itemId],
      flagged: true,
      note: note.trim() || null,
    });
    if (!r.ok) {
      setError(saveErrorSentence(r) ?? "Nothing was saved.");
      setBusy(false);
      return;
    }
    toast("Flagged for review");
    setBusy(false);
    setFormOpen(false);
    setNote("");
    router.refresh();
  }

  async function unflag() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/flag", {
      itemIds: [itemId],
      flagged: false,
    });
    if (!r.ok) {
      toast(saveErrorSentence(r) ?? "Nothing was saved.", { tone: "block" });
      setBusy(false);
      return;
    }
    toast("Unflagged");
    setBusy(false);
    router.refresh();
  }

  // T4 ruling 10: name, never an email. The prop still holds the raw
  // flagged_by (historical type); we derive a display name here.
  const flaggedName = flaggedBy ? nameFromEmail(flaggedBy) : null;
  const title = flagged
    ? (flagNote ? `Flagged: ${flagNote}` : "Flagged for review") +
      (flaggedName ? ` - ${flaggedName}` : "") +
      " - click to clear"
    : "Flag this item for a second look";

  const onBtnClick = () => {
    if (flagged) {
      unflag();
      return;
    }
    setFormOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className={`kf-rvc__flagbtn${flagged ? " kf-rvc__flagbtn--on" : ""}${busy ? " is-busy" : ""}`}
        disabled={busy}
        onClick={onBtnClick}
        title={title}
        aria-pressed={flagged}
        aria-label={flagged ? "Unflag this item" : "Flag this item for review"}
      >
        <Flag size={14} strokeWidth={1.5} aria-hidden />
      </button>
      {formOpen ? (
        <div className="kf-ing-note-form" role="group" aria-label="Flag note">
          <label className="kf-ing-note-form__label" htmlFor={`flag-note-${itemId}`}>
            Flag for a second look. Optional note:
          </label>
          <input
            ref={inputRef}
            id={`flag-note-${itemId}`}
            type="text"
            className="kf-ing-note-form__input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                // T4 §6: a typed note is typed work.
                if (note.trim().length > 0) {
                  setDiscardAsk(true);
                } else {
                  setFormOpen(false);
                  setNote("");
                  setError(null);
                }
              } else if (e.key === "Enter") {
                e.preventDefault();
                saveFlag();
              }
            }}
            disabled={busy}
            placeholder="(optional)"
          />
          <div className="kf-ing-note-form__actions">
            <button
              type="button"
              className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
              disabled={busy}
              onClick={saveFlag}
            >
              {busy ? "Saving..." : "Flag"}
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--line kf-btn--sm"
              disabled={busy}
              onClick={() => {
                if (note.trim().length > 0) {
                  setDiscardAsk(true);
                } else {
                  setFormOpen(false);
                  setNote("");
                  setError(null);
                }
              }}
            >
              Cancel
            </button>
            {error ? (
              <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">
                {error}
              </span>
            ) : null}
            {discardAsk ? (
              <div className="kf-ing-note-form__discard-ask" role="alertdialog" aria-label="Discard what you typed?">
                <span className="kf-ing-note-form__ask-text">Discard what you typed?</span>
                <button
                  type="button"
                  className="kf-btn kf-btn--primary kf-btn--sm"
                  onClick={() => setDiscardAsk(false)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={() => {
                    setDiscardAsk(false);
                    setFormOpen(false);
                    setNote("");
                    setError(null);
                  }}
                >
                  Discard
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
