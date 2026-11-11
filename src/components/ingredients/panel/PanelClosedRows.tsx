"use client";

// N7 §3f: four disclosure rows in order:
//   1. Mark as retail - lazy preview GET on first open (B7)
//   2. Merge          - typeahead + merge confirm
//   3. Evidence       - lazy fetch on first open
//   4. Change history - lazy fetch on first open (LedgerBlock)
//
// Each row owns its own open state. Rows render on the white ground
// under the zones. The disclosure body lazy-mounts its content so no
// fetch fires until the user expands.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { IngredientTypeahead } from "../IngredientTypeahead";
import { EvidenceSection } from "./EvidenceSection";
import { LedgerBlock } from "./LedgerBlock";
import { postJson, errMsg } from "./common";
import { SaveFlash } from "./SaveFlash";

function DisclosureRow({
  label,
  sub,
  initialOpen = false,
  children,
}: {
  label: string;
  sub: string;
  initialOpen?: boolean;
  children: (open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button
        type="button"
        className="kf-ipanel__drow"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="kf-ipanel__drow-label">{label}</span>
        <span className="kf-ipanel__drow-sub">{sub}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          className={`kf-ipanel__drow-chev${open ? " is-open" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="kf-ipanel__drow-body">{children(open)}</div> : null}
    </>
  );
}

// --- Mark as retail ---------------------------------------------------

function RetailRow({
  ingredient,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ active: number; resale: number } | null>(null);

  // Preview GET fires once the row is mounted (i.e. the disclosure is
  // open). Deferred from mount per B7.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/review/set-resale?ingredientId=${encodeURIComponent(ingredient.id)}`
        );
        const data = (await res.json().catch(() => null)) as
          | { confirmedActive?: number; confirmedResale?: number }
          | null;
        if (cancelled || !res.ok || !data) return;
        setPreview({
          active: Number(data.confirmedActive ?? 0),
          resale: Number(data.confirmedResale ?? 0),
        });
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [ingredient.id, savedAt]);

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-resale", {
      ingredientId: ingredient.id,
      resale: next,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    const moved = ((r.data ?? {}) as { moved?: number }).moved ?? 0;
    const base = next ? "Saved: moved to retail bucket" : "Saved: moved to recipe-coverage bucket";
    const direction = next ? "to retail" : "back to active";
    toast(
      moved > 0
        ? `${base} (${fmtCount(moved)} confirmed items moved ${direction})`
        : base
    );
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
  }

  return (
    <div className="kf-dpn__toggle">
      <label className="kf-dpn__toggle-label">
        <input
          type="checkbox"
          checked={ingredient.resale}
          aria-label="Mark as retail"
          onChange={(e) => toggle(e.currentTarget.checked)}
          disabled={busy}
        />
        <span>Retail (not a recipe ingredient)</span>
        <SaveFlash savedAt={savedAt} error={error} />
      </label>
      <div className="kf-dpn__hint">
        Retail items (bottled water, disposables) are tracked but excluded from recipe-coverage.
        {preview
          ? ingredient.resale
            ? preview.resale > 0
              ? ` Unticking also moves ${fmtCount(preview.resale)} confirmed item${preview.resale === 1 ? "" : "s"} back into the working set.`
              : ""
            : preview.active > 0
              ? ` Ticking also moves ${fmtCount(preview.active)} confirmed item${preview.active === 1 ? "" : "s"} out of the working set.`
              : ""
          : ""}
      </div>
    </div>
  );
}

// --- Merge -----------------------------------------------------------

function MergeRow({
  ingredient,
  parents,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  parents: ReviewCardIngredient[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const choices = useMemo(
    () => parents.filter((p) => p.id !== ingredient.id),
    [parents, ingredient.id]
  );

  async function doMerge() {
    if (busy || !target) return;
    const targetRow = parents.find((p) => p.id === target);
    const targetName = targetRow?.name ?? "the chosen ingredient";
    const confirmed = window.confirm(
      `Merge "${ingredient.name}" into "${targetName}"?\n\nEvery item on "${ingredient.name}" will move to "${targetName}". This is reversible from the Recent decisions ledger.`
    );
    if (!confirmed) return;
    setBusy(true);
    const r = await postJson("/api/review/merge-ingredient", {
      sourceId: ingredient.id,
      targetId: target,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Merge failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    const d = r.data as { movedItems?: number };
    const srcId = ingredient.id;
    toast(
      `Merged ${d.movedItems ?? 0} items into ${targetName}`,
      {
        undo: async () => {
          await fetch("/api/review/undo-merge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceId: srcId }),
          });
          onDone();
        },
      }
    );
    setBusy(false);
    onDone();
  }

  return (
    <>
      <IngredientTypeahead
        ingredients={choices}
        excludeId={ingredient.id}
        label="Merge into another ingredient"
        placeholder="Type to search survivors..."
        pickedId={target || null}
        onPick={(id) => setTarget(id ?? "")}
        busy={busy}
      />
      <div className="kf-dpn__hint">
        Its items and confirmed links move to the ingredient you choose. &ldquo;{ingredient.name}&rdquo;
        is kept as a merged record and its name becomes an alias, so the matcher routes the old
        name here automatically. Undoable from Recent decisions.
      </div>
      <div className="kf-dpn__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy || !target}
          onClick={doMerge}
        >
          {busy ? "Saving..." : "Merge into chosen"}
        </button>
      </div>
    </>
  );
}

// --- Public component ------------------------------------------------

export function PanelClosedRows({
  item,
  ingredient,
  parents,
  onDone,
}: {
  item: ReviewGroupItem | null;
  ingredient: ReviewCardIngredient | null;
  parents: ReviewCardIngredient[];
  onDone: () => void;
}) {
  return (
    <>
      {ingredient ? (
        <DisclosureRow label="Mark as retail" sub="move to the retail bucket">
          {() => <RetailRow ingredient={ingredient} onDone={onDone} />}
        </DisclosureRow>
      ) : null}

      {ingredient ? (
        <DisclosureRow label="Merge" sub="fold into another ingredient">
          {() => <MergeRow ingredient={ingredient} parents={parents} onDone={onDone} />}
        </DisclosureRow>
      ) : null}

      {item ? (
        <DisclosureRow label="Evidence" sub="invoice lines, by site, siblings, variants">
          {(open) => <EvidenceSection item={item} open={open} />}
        </DisclosureRow>
      ) : null}

      <DisclosureRow label="Change history" sub="every change, newest first">
        {(open) => (
          <LedgerBlock
            ingredientId={ingredient?.id ?? null}
            itemId={item?.id ?? null}
            open={open}
          />
        )}
      </DisclosureRow>
    </>
  );
}
