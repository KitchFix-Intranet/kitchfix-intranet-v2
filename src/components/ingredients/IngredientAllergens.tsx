"use client";

// B1 (allergens) UI. Nine pills + None + Confirm. One component with
// two call sites:
//
//   - MasterDetail (in-pane in the Ingredients + Resale workbench's
//     right pane, `.kf-dt`): the panel Kevin lands on by clicking a
//     master row.
//   - IngredientBlock (slide-in DetailPanel drawer): the surface the
//     Review queue + the A4 master-name button open.
//
// The initial B1 build placed the block only in the drawer; the
// workbench pane rendered nothing. This component is the single
// source of truth so both surfaces carry the same control, driven by
// the same state machine. See src/lib/ingredients/allergens.ts for
// the canonical nine and the three-state model.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { fmtDate } from "@/lib/fmt";
import { ALLERGENS, type Allergen } from "@/lib/ingredients/allergens";

type Props = {
  ingredientId: string;
  // The master's current saved values. Null `reviewedAt` means
  // unreviewed - must render "Check allergens" above the grid.
  allergens: readonly string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  // Optional: fires after a successful save, before router.refresh().
  // Call sites that need to coordinate (e.g. closing a drawer) wire
  // it; everything else leaves the default no-op.
  onSaved?: () => void;
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

export function IngredientAllergens({
  ingredientId,
  allergens,
  reviewedBy,
  reviewedAt,
  onSaved,
  // N8 §1g: panel renders the chips + Confirm button only; the status
  // pill lives beside the row label and the trailing hint is dropped.
  // Ingredients tab (default) keeps the full head + hint block.
  chrome = "tab",
}: Props & { chrome?: "tab" | "bare" }) {
  const router = useRouter();

  // Seed selection + None from the saved values. The canonical-nine
  // filter here protects the UI if the DB ever grows a tenth tag -
  // we silently ignore anything we don't know. The CHECK constraint
  // would reject it on write anyway.
  const seedSelected = useMemo(
    () => new Set<string>((allergens ?? []).filter((a) => (ALLERGENS as readonly string[]).includes(a))),
    [allergens]
  );
  const seedConfirmNone = reviewedAt != null && (allergens ?? []).length === 0;

  const [selected, setSelected] = useState<Set<string>>(seedSelected);
  const [confirmNone, setConfirmNone] = useState<boolean>(seedConfirmNone);
  // Re-seed on identity change. Navigating from one master to another
  // must pull that master's own saved state, not the previous one's.
  useEffect(() => {
    setSelected(new Set<string>((allergens ?? []).filter((a) => (ALLERGENS as readonly string[]).includes(a))));
    setConfirmNone(reviewedAt != null && (allergens ?? []).length === 0);
  }, [ingredientId, allergens, reviewedAt]);

  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Confirm enablement: enable when the selection differs from saved
  // OR the ingredient is currently unreviewed. The unreviewed branch
  // is what lets "I looked, there is nothing" (confirm "None") leave
  // the queue - a naive selection-changed-only gate would strand
  // unreviewed-with-no-pick ingredients forever.
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
    // Normalise to canonical order on the wire so the server never
    // sees "Peanuts" before "Milk" from a toggle order.
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

  return (
    <div className="kf-allergens">
      {chrome === "tab" ? (
        <div className="kf-allergens__head">
          <span className="kf-allergens__label">Allergens</span>
          {unreviewed ? (
            <span className="kf-allergens__state kf-allergens__state--warn">
              Check allergens
            </span>
          ) : (allergens ?? []).length === 0 ? (
            <span className="kf-allergens__state kf-allergens__state--ok">
              No Top 9 allergens
            </span>
          ) : (
            <span className="kf-allergens__state kf-allergens__state--ok">
              Confirmed
            </span>
          )}
        </div>
      ) : null}
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
      <div className="kf-allergens__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={!canConfirm || busy}
          onClick={confirm}
        >
          {busy ? "Saving..." : "Confirm allergens"}
        </button>
        {savedAt ? <span className="kf-allergens__flash">Saved</span> : null}
        {error ? <span className="kf-allergens__flash kf-allergens__flash--err">{error}</span> : null}
      </div>
      {chrome === "tab" ? (
        reviewedAt ? (
          <div className="kf-allergens__hint">
            Last confirmed by {reviewedBy ?? "someone"} on {fmtDate(reviewedAt, "short")}.
          </div>
        ) : (
          <div className="kf-allergens__hint">
            Unreviewed. Pick a tag or confirm &ldquo;None&rdquo; to clear this from the queue.
          </div>
        )
      ) : null}
    </div>
  );
}

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
