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

export type AllergensHandle = { confirm: () => Promise<void> };
export type AllergensState = {
  canConfirm: boolean;
  busy: boolean;
  savedAt: number | null;
  error: string | null;
};

type Props = {
  ingredientId: string;
  allergens: readonly string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  onSaved?: () => void;
  // Fires on mount and on every change to canConfirm / busy / savedAt
  // / error so the parent can disable + relabel the Confirm button it
  // renders in the row's action column.
  onStateChange?: (s: AllergensState) => void;
};

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

function errMsg(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

export const IngredientAllergens = forwardRef<AllergensHandle, Props>(function IngredientAllergens(
  { ingredientId, allergens, reviewedBy: _reviewedBy, reviewedAt, onSaved, onStateChange },
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
  const canConfirm = unreviewed || !selectionMatchesSaved;

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
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
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
    onStateChange?.({ canConfirm, busy, savedAt, error });
  }, [canConfirm, busy, savedAt, error, onStateChange]);

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
