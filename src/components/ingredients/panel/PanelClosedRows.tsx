"use client";

// N7 §3f + N12 §2c.6: disclosure rows under the zones, in order:
//   1. Mark as retail - lazy preview GET on first open (B7)
//   2. Merge          - typeahead + merge confirm; parents may be
//                       passed in, or fetched on first open via
//                       `onLoadParents` (N12 §R2)
//   3. Evidence       - lazy fetch on first open (hidden when no
//                       item in scope)
//   4. Send all back  - N12 §2c.6; renders when `sendAllBack` is
//                       passed, wrapping MasterSendAllBackButton
//   5. Change history - lazy fetch on first open (LedgerBlock)
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
import { ItemHistoryRows } from "./ItemHistoryRows";
import { LedgerBlock } from "./LedgerBlock";
import { MasterSendAllBackButton } from "../MasterSendAllBackButton";
import { postJson, errMsg } from "./common";
import { SaveFlash } from "./SaveFlash";

function DisclosureRow({
  label,
  sub,
  initialOpen = false,
  onOpenChange,
  children,
}: {
  label: string;
  sub: string;
  initialOpen?: boolean;
  // T3 §1: Merge needs the parent (PanelClosedRows) to know when the
  // row expands, so the parents fetch fires on first expand and
  // doesn't re-run on every re-open (MergeRow unmounts between
  // opens and can't cache state itself).
  onOpenChange?: (open: boolean) => void;
  children: (open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (onOpenChange) onOpenChange(next);
      return next;
    });
  }
  return (
    <>
      <button
        type="button"
        className="kf-ipanel__drow"
        onClick={toggle}
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

// T3 §1: MergeRow is rendered inside a DisclosureRow whose body
// unmounts on close and remounts on re-open. Any fetch state kept
// here is lost between opens, which would mean a fresh GET every
// expand. The fetch now lives above the disclosure (see
// PanelClosedRows) and MergeRow reads the parents + load state as
// props - that way "the list is fetched once per panel, not on
// every open".
function MergeRow({
  ingredient,
  parents,
  loadState,
  loadError,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  parents: ReviewCardIngredient[];
  loadState: "idle" | "loading" | "ready" | "error";
  loadError: string | null;
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

  if (loadState === "loading") {
    return <div className="kf-dpn__hint">Loading ingredient...</div>;
  }
  if (loadState === "error") {
    return (
      <div className="kf-dpn__hint">
        Could not load ingredient: {loadError ?? "unknown error"}
      </div>
    );
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
  parents: parentsProp,
  onLoadParents,
  sendAllBack,
  onDone,
}: {
  item: ReviewGroupItem | null;
  ingredient: ReviewCardIngredient | null;
  parents: ReviewCardIngredient[];
  // N12 §R2: optional lazy fetcher for Merge candidates; fires once
  // per panel, not on every open of the Merge row.
  onLoadParents?: () => Promise<ReviewCardIngredient[]>;
  // N12 §2c.6: when present, "Send all back" renders between Merge
  // (or Evidence) and Change history.
  sendAllBack?: { masterName: string; itemIds: string[] };
  onDone: () => void;
}) {
  // N8 §1i: closed-row sub copy comes from the render.
  const ingredientName = ingredient?.name ?? "this ingredient";

  // T3 §1: parents fetch state lives here (above DisclosureRow) so
  // the fetch fires once per panel, not once per expand. MergeRow
  // unmounts when its disclosure collapses; keeping the state inside
  // MergeRow would re-fetch on every re-open. The effect runs when
  // the Merge disclosure first opens (`mergeOpen` flips true) or when
  // the ingredient changes. parentsProp wins when it was passed in
  // (drawer path on the review queue).
  const [mergeOpen, setMergeOpen] = useState(false);
  const [parents, setParents] = useState<ReviewCardIngredient[]>(parentsProp);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">(
    parentsProp.length > 0 ? "ready" : onLoadParents ? "idle" : "ready"
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Sync parents from prop if the caller ever supplies a non-empty
  // list (drawer path). The Ingredients-tab path leaves this empty
  // and relies on onLoadParents below.
  useEffect(() => {
    if (parentsProp.length > 0) {
      setParents(parentsProp);
      setLoadState("ready");
    }
  }, [parentsProp]);

  // T3 R2-1: reset the cache ONLY when the ingredient id changes.
  // The previous deps `[ingredient?.id, parentsProp.length,
  // onLoadParents]` fired on every router.refresh(): IngredientMasters-
  // Filter's `loadParents` was `useCallback(..., [selected])`, and
  // `selected` is a new object after a refresh, so onLoadParents's
  // identity flipped and this effect set loadState="idle" +
  // parents=[]. The loader effect below did not re-run (loadState is
  // not in its deps), so the Merge picker went empty with no second
  // call and stayed that way.
  //
  // Reset only on id change. parentsProp / onLoadParents identity
  // changes without an id change are no-ops - the loaded list stays.
  useEffect(() => {
    if (parentsProp.length === 0 && onLoadParents) {
      setLoadState("idle");
      setParents([]);
      setLoadError(null);
      // Collapsing the row on ingredient change would surprise the
      // user mid-task; leave mergeOpen alone. If they re-open, the
      // fetch below picks up the fresh ingredient id via its
      // callback identity.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredient?.id]);

  useEffect(() => {
    if (!mergeOpen) return;
    if (loadState !== "idle") return;
    if (!onLoadParents) return;
    let cancelled = false;
    setLoadState("loading");
    (async () => {
      try {
        const ps = await onLoadParents();
        if (cancelled) return;
        setParents(ps);
        setLoadState("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      }
    })();
    return () => { cancelled = true; };
    // `loadState` is read inside the effect but the writes happen
    // through the state setters; the only trigger for a re-run is
    // the row opening or a fresh fetcher. Tracked via mergeOpen +
    // onLoadParents; loadState is intentionally excluded to prevent
    // the re-run / cleanup / cancel race the original code had.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeOpen, onLoadParents]);

  return (
    <div className="kf-ipanel__drows">
      {ingredient ? (
        <DisclosureRow label="Mark as retail" sub={`Takes ${ingredientName} out of recipe coverage`}>
          {() => <RetailRow ingredient={ingredient} onDone={onDone} />}
        </DisclosureRow>
      ) : null}

      {ingredient ? (
        <DisclosureRow
          label="Merge"
          sub={`Fold ${ingredientName} into another ingredient`}
          onOpenChange={setMergeOpen}
        >
          {() => (
            <MergeRow
              ingredient={ingredient}
              parents={parents}
              loadState={loadState}
              loadError={loadError}
              onDone={onDone}
            />
          )}
        </DisclosureRow>
      ) : null}

      {/* N13 §2c + round 2 fix 12: Spend by site + Invoice wording sit
          between Merge and Evidence. Same disclosure primitive, same
          24 inset as the rows beside them. ItemHistoryRows shares one
          lazy fetch between the two expands. priceUom gives the
          "Last paid" cell its unit so it reads "$21.44 / each"
          rather than bare dollars (round 2 fix 13). */}
      {item ? (
        <ItemHistoryRows
          itemId={item.id}
          priceUom={item.perBaseUom ?? item.billedUnit ?? null}
        />
      ) : null}

      {item ? (
        <DisclosureRow label="Evidence" sub="The invoice lines behind this price">
          {(open) => <EvidenceSection item={item} open={open} />}
        </DisclosureRow>
      ) : null}

      {sendAllBack && sendAllBack.itemIds.length > 0 ? (
        <DisclosureRow
          label="Send all back"
          sub={`Return all ${sendAllBack.itemIds.length} items to the review queue`}
        >
          {() => (
            <div className="kf-dpn__btns">
              <MasterSendAllBackButton
                masterName={sendAllBack.masterName}
                itemIds={sendAllBack.itemIds}
              />
            </div>
          )}
        </DisclosureRow>
      ) : null}

      <DisclosureRow label="Change history" sub="Every change, newest first">
        {(open) => (
          <LedgerBlock
            ingredientId={ingredient?.id ?? null}
            itemId={item?.id ?? null}
            open={open}
          />
        )}
      </DisclosureRow>
    </div>
  );
}
