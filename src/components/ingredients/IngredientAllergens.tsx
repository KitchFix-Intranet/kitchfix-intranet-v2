"use client";

// B1 (allergens) UI.
//
// N12 round 2 (fix 8): the shared block renders the 5 x 2 pill grid
// only. The Confirm button sits in the mounting row's action column
// (frame A); the parent reaches the confirm trigger via a ref
// (useImperativeHandle) and reflects enablement + busy state via an
// onStateChange callback. PanelIngredientZone is the sole mount
// today; both the Review-queue drawer and the Ingredients-tab detail
// pane go through it.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { ALLERGENS, type Allergen } from "@/lib/ingredients/allergens";
import { postJson, saveErrorSentence } from "./panel/common";
import { useDirtyEditor } from "./panel/dirty";
// N13.1 R2: own the sheet. Mounted only by PanelIngredientZone today,
// so the panel reaches the grid + toggle rules through this import on
// every surface including Vendor items (where review.css is absent).
import "./ingredient-allergens.css";

export type AllergensHandle = { confirm: () => Promise<void> };
// T7 ruling 1: the button's label depends on the pair (dirty,
// reviewed). The route couples saving tags with marking checked, so
// the UI holds ticks locally until one deliberate press. Three
// kinds:
//   "dirty-save"       - ticks differ from stored; button reads
//                        "Save and mark as checked" and posts the
//                        new array (route stamps reviewed_at too).
//   "mark-checked"     - ticks match stored AND the ingredient has
//                        never been checked; button reads "Mark as
//                        checked" and posts the SAME array to let
//                        the route stamp reviewed_at.
//   "checked-noop"     - reviewed AND ticks match; no button;
//                        the row reads "Checked" + its date.
export type AllergensKind = "dirty-save" | "mark-checked" | "checked-noop";
export type AllergensState = {
  kind: AllergensKind;
  canConfirm: boolean;
  busy: boolean;
  savedAt: number | null;
  error: string | null;
  reviewedAt: string | null;
};

type Props = {
  ingredientId: string;
  allergens: readonly string[];
  // T5b item 6: `reviewedBy` is gone. Only the timestamp decides
  // whether to seed the "confirmed none" chip (see seedConfirmNone
  // below). The reviewer's email is not read on this screen.
  reviewedAt: string | null;
  onSaved?: () => void;
  // Fires on mount and on every change to canConfirm / busy / savedAt
  // / error so the parent can disable + relabel the Confirm button it
  // renders in the row's action column.
  onStateChange?: (s: AllergensState) => void;
};

export const IngredientAllergens = forwardRef<AllergensHandle, Props>(function IngredientAllergens(
  { ingredientId, allergens, reviewedAt, onSaved, onStateChange },
  ref,
) {
  const router = useRouter();

  const seedSelected = useMemo(
    () => new Set<string>((allergens ?? []).filter((a) => (ALLERGENS as readonly string[]).includes(a))),
    [allergens]
  );
  const seedConfirmNone = reviewedAt != null && (allergens ?? []).length === 0;

  const [selected, setSelected] = useState<Set<string>>(seedSelected);
  const [confirmNone, setConfirmNone] = useState<boolean>(seedConfirmNone);
  useEffect(() => {
    setSelected(new Set<string>((allergens ?? []).filter((a) => (ALLERGENS as readonly string[]).includes(a))));
    setConfirmNone(reviewedAt != null && (allergens ?? []).length === 0);
  }, [ingredientId, allergens, reviewedAt]);

  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unreviewed = reviewedAt == null;
  const savedSet = useMemo(() => new Set<string>(allergens ?? []), [allergens]);
  const selectionMatchesSaved = useMemo(() => {
    if (selected.size !== savedSet.size) return false;
    for (const a of selected) if (!savedSet.has(a)) return false;
    return true;
  }, [selected, savedSet]);
  // T7 ruling 1: three kinds. canConfirm stays false only when the
  // ingredient has been checked AND the ticks match what is stored;
  // in that case the parent's row reads "Checked, DATE" without a
  // button.
  const kind: AllergensKind =
    !selectionMatchesSaved ? "dirty-save"
    : unreviewed ? "mark-checked"
    : "checked-noop";
  const canConfirm = kind !== "checked-noop";
  // T2 §3 + holding note: a changed tick-box grid is a changed editor.
  // The Discard ask resets the selection + confirm-none to what is
  // stored and the Confirm button goes quiet again.
  useDirtyEditor(
    `allergens-${ingredientId}`,
    !selectionMatchesSaved && !busy,
    () => {
      setSelected(new Set<string>((allergens ?? []).filter((a) => (ALLERGENS as readonly string[]).includes(a))));
      setConfirmNone(reviewedAt != null && (allergens ?? []).length === 0);
      setError(null);
    }
  );

  function togglePill(a: Allergen) {
    setConfirmNone(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }
  function toggleNone() {
    setConfirmNone((prev) => {
      const next = !prev;
      if (next) setSelected(new Set<string>());
      return next;
    });
  }

  async function confirm() {
    if (busy || !canConfirm) return;
    setBusy(true);
    setError(null);
    const payload = ALLERGENS.filter((a) => selected.has(a));
    const r = await postJson("/api/review/set-allergens", {
      ingredientId,
      allergens: payload,
    });
    if (!r.ok) {
      // T2 §1: one vocabulary for the failure sentence; no status
      // number on the page. The parent reflects `error` beside the
      // Confirm button via onStateChange; no block toast needed.
      const msg = saveErrorSentence(r) ?? "Nothing was saved.";
      setError(msg);
      setBusy(false);
      return;
    }
    toast(
      payload.length === 0
        ? "Confirmed: no Top 9 allergens"
        : `Confirmed ${payload.length} allergen${payload.length === 1 ? "" : "s"}`,
      { tone: "good" }
    );
    setSavedAt(Date.now());
    setBusy(false);
    onSaved?.();
    router.refresh();
  }

  // Latest confirm in a ref so useImperativeHandle always returns the
  // current closure without needing to re-register on every render.
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useImperativeHandle(ref, () => ({ confirm: () => confirmRef.current() }), []);

  // Report state to the parent on every change. Guard against null
  // callback so the one call site that does not need it pays nothing.
  useEffect(() => {
    onStateChange?.({ kind, canConfirm, busy, savedAt, error, reviewedAt });
  }, [kind, canConfirm, busy, savedAt, error, reviewedAt, onStateChange]);

  return (
    <div className="kf-allergens__grid" role="group" aria-label="Top 9 allergens">
      {ALLERGENS.map((a) => {
        const on = selected.has(a);
        return (
          <button
            key={a}
            type="button"
            className={`kf-allergen${on ? " kf-allergen--on" : ""}`}
            aria-pressed={on}
            onClick={() => togglePill(a)}
            disabled={busy}
          >
            {a}
          </button>
        );
      })}
      <button
        type="button"
        className={`kf-allergen kf-allergen--none${confirmNone ? " kf-allergen--on" : ""}`}
        aria-pressed={confirmNone}
        onClick={toggleNone}
        disabled={busy}
        title="No Top 9 allergens in this ingredient"
      >
        None
      </button>
    </div>
  );
});

// Convenience helper for the panel: compute the status string that
// replaces the component's own head pill. Keeps the three sanctioned
// wordings in one place so the panel and tab cannot drift.
export function allergenStatus(
  allergens: readonly string[] | null,
  reviewedAt: string | null,
): { label: string; tone: "warn" | "good" } {
  const list = allergens ?? [];
  if (reviewedAt == null) return { label: "not reviewed", tone: "warn" };
  if (list.length === 0) return { label: "no Top 9 allergens", tone: "good" };
  return { label: "confirmed", tone: "good" };
}
