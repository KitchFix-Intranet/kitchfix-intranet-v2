"use client";

// Right-side slide-in detail panel for the review queue. One instance
// per ReviewCard; opens via local useState from the card's row buttons
// (kind: "item") or the header title button (kind: "ingredient").
//
// Shape:
//   - Ingredient section (always, when ingredient exists): rename,
//     category (super) + sub (parent), resale toggle. Each sub-form has
//     its own Save; successful writes router.refresh() so the pre-
//     rendered server cards re-read the DB.
//   - Item section (only when kind=item): item facts (name, vendor, #,
//     pack, unit, 12m $, lines, sites, last seen, confidence, unit
//     price) + pack-override form.
//
// Reuses the kf-drawer* CSS from drawer.css for the backdrop + slide-in
// mechanics; the panel-internal form styles live in review.css under
// kf-dpn__*. Owns its own Esc / backdrop / focus-trap handling - not
// coupled to a URL param (unlike the vendor-item DrawerFrame).

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong, timeAgo } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { humanizeKind } from "@/lib/humanizeKind";
import { IngredientTypeahead } from "./IngredientTypeahead";
import type { ReviewCardIngredient, ReviewGroupItem } from "./ReviewCard";
import "./drawer.css";

// Inline "Saved just now" badge. Pass a `savedAt` timestamp (Date.now())
// after a successful write; the badge renders for 2.5s then hides.
// Error flashes also live here via `error` string.
function SaveFlash({ savedAt, error }: { savedAt: number | null; error: string | null }) {
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (!savedAt) {
      setShowSaved(false);
      return;
    }
    setShowSaved(true);
    const t = window.setTimeout(() => setShowSaved(false), 2500);
    return () => window.clearTimeout(t);
  }, [savedAt]);
  if (error) {
    return <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">{error}</span>;
  }
  if (showSaved) {
    return (
      <span className="kf-dpn__flash kf-dpn__flash--ok" aria-live="polite">
        <Check size={14} strokeWidth={2} aria-hidden />
        <span>Saved</span>
      </span>
    );
  }
  return null;
}

export type DetailPanelOpen =
  | null
  | { kind: "item"; itemId: string }
  | { kind: "ingredient" };

const EXIT_MS = 200;

export function DetailPanel({
  open,
  onClose,
  ingredient,
  items,
  parents,
  proposedName,
  proposedParent,
}: {
  open: Exclude<DetailPanelOpen, null>;
  onClose: () => void;
  // null for ai-new groups where the ingredient doesn't exist yet.
  // The item facts section still renders; the ingredient-edit section
  // shows a "create ingredient first" placeholder instead.
  ingredient: ReviewCardIngredient | null;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
  proposedName?: string | null;
  proposedParent?: string | null;
}) {
  const router = useRouter();
  const labelId = useId();
  const asideRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState(false);

  // Unique parents from the ingredients list, sorted. Used by the
  // sub-category dropdown. New parents are allowed via the inline
  // "add new sub-category" input.
  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of parents) {
      if (p.parent && p.parent.trim().length > 0) set.add(p.parent);
    }
    return Array.from(set).sort();
  }, [parents]);

  const item = open.kind === "item" ? items.find((i) => i.id === open.itemId) ?? null : null;

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && asideRef.current) {
        const focusables = asideRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        className={`kf-drawer__backdrop${closing ? " is-closing" : ""}`}
        onClick={close}
        aria-hidden
      />
      <aside
        ref={asideRef}
        className={`kf-drawer${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <button
          type="button"
          ref={closeBtnRef}
          className="kf-drawer__close"
          onClick={close}
          aria-label="Close"
        >
          <X size={20} strokeWidth={1.5} />
        </button>

        <div className="kf-drawer__head">
          <span className="kf-eyebrow kf-eyebrow--plain">
            {open.kind === "item" ? "Vendor item" : "Ingredient"}
          </span>
          <h3 id={labelId} className="kf-drawer__name">
            {open.kind === "item" && item
              ? item.displayName
              : ingredient
                ? ingredient.name
                : proposedName ?? "New ingredient"}
          </h3>
          <div className="kf-drawer__chips">
            {ingredient ? (
              <>
                {ingredient.category ? (
                  <span className="kf-pill kf-pill--muted">{ingredient.category}</span>
                ) : (
                  <span className="kf-pill kf-pill--warn">Needs category</span>
                )}
                {ingredient.parent ? (
                  <span className="kf-pill kf-pill--muted">{ingredient.parent}</span>
                ) : null}
                {ingredient.resale ? <span className="kf-pill kf-pill--muted">Resale</span> : null}
              </>
            ) : (
              <span className="kf-pill kf-pill--warn">Not yet created</span>
            )}
          </div>
        </div>

        {open.kind === "item" && item ? (
          <ItemFacts item={item} />
        ) : null}

        {ingredient ? (
          <IngredientBlock
            ingredient={ingredient}
            parentOptions={parentOptions}
            parents={parents}
            onDone={() => router.refresh()}
          />
        ) : (
          <PendingIngredientBlock
            proposedName={proposedName ?? null}
            proposedParent={proposedParent ?? null}
          />
        )}

        {open.kind === "item" && item ? (
          <PackOverrideBlock item={item} onDone={() => router.refresh()} />
        ) : null}

        <LedgerBlock
          ingredientId={ingredient?.id ?? null}
          itemId={open.kind === "item" ? open.itemId : null}
        />
      </aside>
    </>
  );
}

// Per-item change ledger. Reads pr_events for THIS ingredient and
// vendor-item via a dedicated API endpoint (/api/review/item-events).
// Fetches on mount; shows last ~10 events newest-first with
// Chicago-friendly timestamps via fmtDate(.., "time") + a relative
// `timeAgo` sub-line. Each event kind gets a human-readable description
// pulled from `before`/`after` snapshots.
type LedgerEvent = {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function LedgerBlock({ ingredientId, itemId }: { ingredientId: string | null; itemId: string | null }) {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ingredientId && !itemId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (ingredientId) params.set("ingredientId", ingredientId);
        if (itemId) params.set("itemId", itemId);
        const res = await fetch(`/api/review/item-events?${params.toString()}`, {
          method: "GET",
        });
        const data = (await res.json().catch(() => null)) as {
          events?: LedgerEvent[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.events) {
          setError(data?.error ?? `Load ${res.status}`);
          setEvents([]);
          return;
        }
        setEvents(data.events);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setEvents([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingredientId, itemId]);

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Change history">
      <header className="kf-drawer__block-head">
        <h4>Change history</h4>
        <small>last 10 actions, newest first</small>
      </header>

      {events === null ? (
        <div className="kf-dpn__ledger-loading">Loading history...</div>
      ) : error ? (
        <div className="kf-dpn__ledger-empty">Could not load: {error}</div>
      ) : events.length === 0 ? (
        <div className="kf-dpn__ledger-empty">
          No edits yet. Rename / category / resale / pack changes will show here with who and when.
        </div>
      ) : (
        <ul className="kf-dpn__ledger-list">
          {events.slice(0, 10).map((e) => (
            <LedgerRowItem key={e.id} e={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LedgerRowItem({ e }: { e: LedgerEvent }) {
  const { label, body } = describeEvent(e);
  const actor = e.actor ?? "-";
  return (
    <li className="kf-dpn__ledger-item">
      <span className="kf-dpn__ledger-kind">{label}</span>
      <span className="kf-dpn__ledger-body">{body}</span>
      <span className="kf-dpn__ledger-meta">
        <time dateTime={e.at} title={fmtDate(e.at, "time")}>{fmtDate(e.at, "time")}</time>
        {" · "}
        {actor}
        {" · "}
        {timeAgo(e.at)}
      </span>
    </li>
  );
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function describeEvent(e: LedgerEvent): { label: string; body: React.ReactNode } {
  const before = e.before ?? {};
  const after = e.after ?? {};
  if (e.kind === "ingredient_renamed") {
    const oldName = asStr(before.name);
    const newName = asStr(after.name);
    return {
      label: "Renamed",
      body: (
        <>
          {oldName ? <><strong>{oldName}</strong> → </> : null}
          <strong>{newName ?? "(unknown)"}</strong>
        </>
      ),
    };
  }
  if (e.kind === "ingredient_category_set") {
    const oldCat = asStr(before.category);
    const newCat = asStr(after.category);
    const oldSub = asStr(before.parent);
    const newSub = asStr(after.parent);
    return {
      label: "Category",
      body: (
        <>
          {oldCat || oldSub ? <>{oldCat ?? "Needs category"}{oldSub ? ` / ${oldSub}` : ""} → </> : null}
          <strong>{newCat ?? "Needs category"}{newSub ? ` / ${newSub}` : ""}</strong>
        </>
      ),
    };
  }
  if (e.kind === "ingredient_resale_set") {
    const next = after.resale === true;
    return {
      label: "Resale",
      body: <>Moved to <strong>{next ? "resale bucket" : "recipe coverage"}</strong></>,
    };
  }
  if (e.kind === "pack_override_set") {
    const packText = asStr(after.pack_text);
    const unit = asStr(after.billed_unit);
    return {
      label: "Pack size",
      body: (
        <>
          Set to <strong>{packText ?? "-"}</strong>
          {unit ? <> / {unit}</> : null} (manually entered)
        </>
      ),
    };
  }
  if (e.kind === "ingredient_merged") {
    const srcName = asStr(before.source_name);
    const tgtName = asStr(after.target_name);
    const moved =
      typeof after.moved_items === "number" ? after.moved_items : null;
    return {
      label: "Merged",
      body: (
        <>
          {srcName ? <><strong>{srcName}</strong></> : "This ingredient"} merged into{" "}
          <strong>{tgtName ?? "another"}</strong>
          {moved != null ? <> ({moved} items moved)</> : null}
        </>
      ),
    };
  }
  if (e.kind === "ingredient_merge_undo") {
    return { label: "Undo merge", body: <>Merge reversed; items restored.</> };
  }
  if (e.kind === "ingredient_created") {
    const name = asStr(after.name);
    return {
      label: "Created",
      body: (
        <>
          Ingredient <strong>{name ?? "(unknown)"}</strong> created
        </>
      ),
    };
  }
  if (e.kind === "ingredient_split_create") {
    const name = asStr(after.name);
    const movedIds = Array.isArray(after.moved_item_ids) ? after.moved_item_ids.length : null;
    return {
      label: "Split",
      body: (
        <>
          Split into new ingredient <strong>{name ?? "(unknown)"}</strong>
          {movedIds != null ? <> ({movedIds} items)</> : null}
        </>
      ),
    };
  }
  if (e.kind === "review_confirm") {
    const n = typeof after.confirmed === "number" ? after.confirmed : null;
    return {
      label: "Confirmed",
      body: n != null ? <>Confirmed <strong>{n}</strong> items</> : <>Confirmed</>,
    };
  }
  if (e.kind === "review_undo") {
    return { label: "Undo confirm", body: <>Reversed one confirm.</> };
  }
  // Fallback for any other kind - humanize via the shared helper.
  return {
    label: humanizeKind(e.kind, 1),
    body: <span className="kf-muted">(no details)</span>,
  };
}

// For ai-new groups: the ingredient doesn't exist yet, so the normal
// rename / category / resale / merge forms have nothing to act on.
// This placeholder reads the AI's proposed name + parent and points
// Kevin at the "Create ingredient" button in the review card.
function PendingIngredientBlock({
  proposedName,
  proposedParent,
}: {
  proposedName: string | null;
  proposedParent: string | null;
}) {
  return (
    <section className="kf-drawer__block kf-dpn__pending" aria-label="Ingredient not yet created">
      <header className="kf-drawer__block-head">
        <h4>Ingredient not yet created</h4>
        <small>finish the create flow to edit</small>
      </header>
      <p className="kf-dpn__pending-body">
        The matcher proposed <strong>{proposedName ?? "a new ingredient"}</strong>
        {proposedParent ? <> under <strong>{proposedParent}</strong></> : null}. Hit
        &ldquo;New ingredient&rdquo; on the card below to create it (category required). Rename,
        category, resale, and merge become available once it exists.
      </p>
    </section>
  );
}

function ItemFacts({ item }: { item: ReviewGroupItem }) {
  const packSourceLabel =
    item.packSource === "override" ? "manually entered"
      : item.packSource === "catalog" ? "catalog"
        : item.packSource === "invoice" ? "invoice"
          : null;
  return (
    <section className="kf-drawer__block" aria-label="Item facts">
      {item.displayNameSource === "catalog" && item.vendorOcrName !== item.displayName ? (
        <div className="kf-dpn__ocr" title="Vendor's invoice description (verbatim)">
          Invoice description: <span>{item.vendorOcrName}</span>
        </div>
      ) : null}
      <dl className="kf-facts">
        <div>
          <dt>Vendor</dt>
          <dd>{item.vendor}</dd>
        </div>
        <div>
          <dt>Vendor item no.</dt>
          <dd>{item.itemNumber ?? <span className="kf-muted">none</span>}</dd>
        </div>
        <div>
          <dt>Pack size</dt>
          <dd>
            {item.packNormalized ?? item.pack ?? <span className="kf-muted">-</span>}
            {packSourceLabel ? (
              <span className={`kf-facts__note${item.packSource === "override" ? " kf-facts__note--warn" : ""}`}>
                {packSourceLabel}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Billed unit</dt>
          <dd>{item.billedUnit ?? <span className="kf-muted">-</span>}</dd>
        </div>
        <div>
          <dt>Unit price</dt>
          <dd>
            {/* Headline = per-unit (always). Secondary = case price. */}
            {item.perBase != null && item.perBaseUom && item.perBaseConfidence ? (
              <>
                <strong>{fmtUsd(item.perBase)}</strong>
                <span className="kf-muted">
                  {" "}/ {item.perBaseUom === "LB" ? "lb"
                      : item.perBaseUom === "FLOZ" ? "fl oz"
                      : item.perBaseUom === "EA" ? "each"
                      : item.perBaseUom.toLowerCase()}
                </span>
                {item.perBaseConfidence === "override" ? (
                  <span className="kf-facts__note">override</span>
                ) : item.perBaseConfidence === "high" ? (
                  <span className="kf-facts__note">per-unit (high)</span>
                ) : (
                  <span className="kf-facts__note kf-facts__note--warn">est. (low)</span>
                )}
                {item.perBaseNote ? (
                  <div className="kf-cell-sub kf-cell-sub--dim">{item.perBaseNote}</div>
                ) : null}
              </>
            ) : (
              <>
                <strong className="kf-muted">- / unit</strong>
                <span className="kf-facts__note kf-facts__note--warn">needs pack</span>
              </>
            )}
            {item.catalogPrice != null ? (
              <div className="kf-cell-sub kf-cell-sub--dim">
                {fmtUsd(item.catalogPrice)} case (catalog)
              </div>
            ) : item.unitPrice != null ? (
              <div className="kf-cell-sub kf-cell-sub--dim">
                {fmtUsd(item.unitPrice)}
                {item.unitPriceUnit ? ` /${item.unitPriceUnit}` : ""} case (billed, latest)
              </div>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Annual spend</dt>
          <dd>${fmtUsdLong(item.usd12m).replace(/^\$/, "")}</dd>
        </div>
        <div>
          <dt>Annual lines</dt>
          <dd>{fmtCount(item.lines12m)}</dd>
        </div>
        <div>
          <dt>Sites</dt>
          <dd>
            {item.accounts.length > 0 ? (
              <span className="kf-site-pills">
                {item.accounts.map((c) => (
                  <span key={c} className="kf-site-pill">{c}</span>
                ))}
              </span>
            ) : (
              <span className="kf-muted">-</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Last purchase</dt>
          <dd>{item.lastSeen ? fmtDate(item.lastSeen) : <span className="kf-muted">-</span>}</dd>
        </div>
        {item.gtin ? (
          <div>
            <dt>GTIN</dt>
            <dd className="kf-dpn__gtin">{item.gtin}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

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

function IngredientBlock({
  ingredient,
  parentOptions,
  parents,
  onDone,
}: {
  ingredient: ReviewCardIngredient;
  parentOptions: string[];
  parents: ReviewCardIngredient[];
  onDone: () => void;
}) {
  // Each sub-form owns its own draft + busy flag. All post to a
  // distinct /api/review/* route; on success toast + onDone to refresh
  // the server-rendered cards so the chip/row readouts update.
  const [renameDraft, setRenameDraft] = useState(ingredient.name);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameSavedAt, setRenameSavedAt] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [superDraft, setSuperDraft] = useState<string>(ingredient.category ?? "");
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(ingredient.parent ?? "");
  const [subNew, setSubNew] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [catSavedAt, setCatSavedAt] = useState<number | null>(null);
  const [catError, setCatError] = useState<string | null>(null);

  const [resaleBusy, setResaleBusy] = useState(false);
  const [resaleSavedAt, setResaleSavedAt] = useState<number | null>(null);
  const [resaleError, setResaleError] = useState<string | null>(null);

  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [mergeBusy, setMergeBusy] = useState(false);
  // Other active ingredients to merge INTO. Exclude self; parents is
  // already filtered server-side to status='active'.
  const mergeChoices = useMemo(
    () => parents.filter((p) => p.id !== ingredient.id),
    [parents, ingredient.id]
  );

  async function doRename() {
    const next = renameDraft.trim();
    if (renameBusy) return;
    if (next.length < 2) { toast("Name is too short", { tone: "block" }); return; }
    if (next === ingredient.name) { toast("Same name, nothing to save"); return; }
    setRenameBusy(true);
    setRenameError(null);
    const r = await postJson("/api/review/rename-ingredient", {
      ingredientId: ingredient.id,
      newName: next,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Rename failed (${r.status})`);
      setRenameError(msg);
      toast(msg, { tone: "block" });
      setRenameBusy(false);
      return;
    }
    const d = r.data as { aliasWritten?: boolean };
    toast(
      d.aliasWritten
        ? `Saved - old name kept as an alias so links survive`
        : `Saved: name`
    );
    setRenameSavedAt(Date.now());
    setRenameBusy(false);
    onDone();
  }

  async function doCategory() {
    if (catBusy) return;
    const nextSuper: SuperCategory | null = superDraft === "" ? null : (superDraft as SuperCategory);
    const nextSub =
      subMode === "new" ? subNew.trim() || null : (subPick === "" ? null : subPick);
    setCatBusy(true);
    setCatError(null);
    const r = await postJson("/api/review/set-category", {
      ingredientId: ingredient.id,
      category: nextSuper,
      parent: nextSub,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setCatError(msg);
      toast(msg, { tone: "block" });
      setCatBusy(false);
      return;
    }
    toast(nextSuper ? `Saved: category ${nextSuper}` : "Saved: Needs category");
    setCatSavedAt(Date.now());
    setCatBusy(false);
    onDone();
  }

  async function toggleResale(next: boolean) {
    if (resaleBusy) return;
    setResaleBusy(true);
    setResaleError(null);
    const r = await postJson("/api/review/set-resale", {
      ingredientId: ingredient.id,
      resale: next,
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setResaleError(msg);
      toast(msg, { tone: "block" });
      setResaleBusy(false);
      return;
    }
    toast(next ? "Saved: moved to resale bucket" : "Saved: moved to recipe-coverage bucket");
    setResaleSavedAt(Date.now());
    setResaleBusy(false);
    onDone();
  }

  // Merge THIS ingredient (source) INTO a chosen target. Items + active
  // golden links move; source goes status='merged' with merged_into_id
  // set; source's old name becomes a kind='rename' alias on the
  // target. Undo is available from the toast + from the Recent-
  // decisions ledger. See mergeIngredients() for the full write set.
  async function doMerge() {
    if (mergeBusy || !mergeTarget) return;
    const targetRow = parents.find((p) => p.id === mergeTarget);
    const targetName = targetRow?.name ?? "the chosen ingredient";
    const confirmed = window.confirm(
      `Merge "${ingredient.name}" into "${targetName}"?\n\nEvery item on "${ingredient.name}" will move to "${targetName}". This is reversible from the Recent decisions ledger.`
    );
    if (!confirmed) return;
    setMergeBusy(true);
    const r = await postJson("/api/review/merge-ingredient", {
      sourceId: ingredient.id,
      targetId: mergeTarget,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Merge failed (${r.status})`), { tone: "block" });
      setMergeBusy(false);
      return;
    }
    const d = r.data as { movedItems?: number; movedGoldenLinks?: number };
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
    setMergeBusy(false);
    onDone();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Edit ingredient">
      <header className="kf-drawer__block-head">
        <h4>Edit ingredient</h4>
        <small>reversible; each save logs to the ledger</small>
      </header>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Name</span>
          <input
            type="text"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder="Ingredient name"
          />
        </label>
        <div className="kf-dpn__hint">
          Old name is kept as an alias (<code>kind=&apos;rename&apos;</code>) so linked items stay linked.
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${renameBusy ? " is-busy" : ""}`}
            disabled={renameBusy || renameDraft.trim().length < 2 || renameDraft.trim() === ingredient.name}
            onClick={doRename}
          >
            {renameBusy ? "Saving..." : "Save name"}
          </button>
          <SaveFlash savedAt={renameSavedAt} error={renameError} />
        </div>
      </div>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Category</span>
          <select value={superDraft} onChange={(e) => setSuperDraft(e.target.value)}>
            <option value="">Needs category</option>
            {SUPER_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="kf-dpn__label">
          <span>Sub-category</span>
          {subMode === "pick" ? (
            <select value={subPick} onChange={(e) => setSubPick(e.target.value)}>
              <option value="">(none)</option>
              {parentOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={subNew}
              onChange={(e) => setSubNew(e.target.value)}
              placeholder="New sub-category"
              autoFocus
            />
          )}
        </label>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ add new sub-category" : "pick existing"}
          </button>
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${catBusy ? " is-busy" : ""}`}
            disabled={catBusy}
            onClick={doCategory}
          >
            {catBusy ? "Saving..." : "Save category"}
          </button>
          <SaveFlash savedAt={catSavedAt} error={catError} />
        </div>
      </div>

      <div className="kf-dpn__row">
        <div className="kf-dpn__toggle">
          <label className="kf-dpn__toggle-label">
            <input
              type="checkbox"
              checked={ingredient.resale}
              aria-label="Mark as resale"
              onChange={(e) => {
                const v = e.currentTarget.checked;
                toggleResale(v);
              }}
              disabled={resaleBusy}
            />
            <span>Resale (not a recipe ingredient)</span>
            <SaveFlash savedAt={resaleSavedAt} error={resaleError} />
          </label>
          <div className="kf-dpn__hint">
            Resale items (bottled water, disposables) are tracked but excluded from recipe-coverage.
          </div>
        </div>
      </div>

      <div className="kf-dpn__row">
        <IngredientTypeahead
          ingredients={mergeChoices}
          excludeId={ingredient.id}
          label="Merge into another ingredient"
          placeholder="Type to search survivors..."
          pickedId={mergeTarget || null}
          onPick={(id) => setMergeTarget(id ?? "")}
          busy={mergeBusy}
        />
        <div className="kf-dpn__hint">
          Items + active golden links move to the survivor. &ldquo;{ingredient.name}&rdquo; stays queryable
          with <code>status=&apos;merged&apos;</code> and its name becomes an alias so matcher runs
          auto-route the old name. Undoable from Recent decisions.
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--line kf-btn--sm${mergeBusy ? " is-busy" : ""}`}
            disabled={mergeBusy || !mergeTarget}
            onClick={doMerge}
          >
            {mergeBusy ? "Saving..." : "Merge into chosen"}
          </button>
        </div>
      </div>
    </section>
  );
}

// Structured pack-override editor (Phase 1.8). Replaces the free-text
// single input. Captures qty/size/uom via typed inputs + a dropdown so
// every save has the fields the per-unit math needs; computes the live
// preview from the same base-unit table as the server (OVERRIDE_TO_BASE
// in estimate.ts; mirrored here for the client preview). On save,
// propagates to same-SKU twins.
const UOM_GROUPS: Array<{ label: string; options: string[] }> = [
  { label: "Weight", options: ["LB", "OZ", "G", "KG"] },
  { label: "Volume", options: ["FLOZ", "GAL", "QT", "L", "ML", "PT"] },
  { label: "Count", options: ["EA", "CT", "DZ", "PC"] },
];
const UOM_TO_BASE: Record<string, { base: "LB" | "FLOZ" | "EA"; factor: number }> = {
  LB: { base: "LB", factor: 1 },
  OZ: { base: "LB", factor: 1 / 16 },
  G: { base: "LB", factor: 1 / 453.592 },
  KG: { base: "LB", factor: 2.20462 },
  FLOZ: { base: "FLOZ", factor: 1 },
  L: { base: "FLOZ", factor: 33.814 },
  ML: { base: "FLOZ", factor: 0.033814 },
  GAL: { base: "FLOZ", factor: 128 },
  QT: { base: "FLOZ", factor: 32 },
  PT: { base: "FLOZ", factor: 16 },
  EA: { base: "EA", factor: 1 },
  CT: { base: "EA", factor: 1 },
  DZ: { base: "EA", factor: 12 },
  PC: { base: "EA", factor: 1 },
};
const UOM_LABEL: Record<"LB" | "FLOZ" | "EA", string> = {
  LB: "lb",
  FLOZ: "fl oz",
  EA: "each",
};

function PackOverrideBlock({
  item,
  onDone,
}: {
  item: ReviewGroupItem;
  onDone: () => void;
}) {
  // Prefill: catch-weight toggle takes the item's current flag; $/lb
  // takes any existing per-base when catch; qty/size left blank for
  // the human to type (we don't surface the raw override jsonb on the
  // ReviewGroupItem). UOM defaults to LB - the most common choice.
  const [catchWeight, setCatchWeight] = useState<boolean>(item.catchWeight);
  const [qtyStr, setQtyStr] = useState<string>("");
  const [sizeStr, setSizeStr] = useState<string>("");
  const [uom, setUom] = useState<string>("LB");
  const [perLbStr, setPerLbStr] = useState<string>(
    item.perBase != null && item.catchWeight ? String(item.perBase) : ""
  );
  const [billedUnit, setBilledUnit] = useState<string>(item.billedUnit ?? "");
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTwins, setLastTwins] = useState<number | null>(null);

  const qty = Number(qtyStr);
  const size = Number(sizeStr);
  const perLb = Number(perLbStr);
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const sizeValid = Number.isFinite(size) && size > 0;
  const perLbValid = Number.isFinite(perLb) && perLb > 0;

  // Live preview math - mirrors estimateFromOverride for a client-side
  // display BEFORE the save; the server re-does the math from the same
  // table so there's no drift risk.
  const previewCasePrice =
    item.catalogPrice != null && item.catalogPrice > 0
      ? { v: item.catalogPrice, src: "catalog" as const }
      : item.unitPrice != null && item.unitPrice > 0
        ? { v: item.unitPrice, src: "billed" as const }
        : null;

  let preview: { line: string; dim: string | null; perBase: number | null } = { line: "", dim: null, perBase: null };
  if (catchWeight) {
    if (perLbValid) {
      preview = {
        line: `${fmtUsd(perLb)} / lb (catch-weight)`,
        dim: "weight",
        perBase: perLb,
      };
    } else {
      preview = { line: "enter $/lb to preview", dim: null, perBase: null };
    }
  } else {
    if (qtyValid && sizeValid && uom && UOM_TO_BASE[uom]) {
      const b = UOM_TO_BASE[uom];
      const total = qty * size * b.factor;
      if (previewCasePrice) {
        preview = {
          line: `${qty} x ${size} ${uom} = ${total.toFixed(2)} ${UOM_LABEL[b.base]} -> ${fmtUsd(previewCasePrice.v / total)} / ${UOM_LABEL[b.base]}  (case ${fmtUsd(previewCasePrice.v)} ${previewCasePrice.src})`,
          dim: "math",
          perBase: previewCasePrice.v / total,
        };
      } else {
        preview = {
          line: `${qty} x ${size} ${uom} = ${total.toFixed(2)} ${UOM_LABEL[b.base]}  (no case price on file - per-unit will be blank)`,
          dim: "no-price",
          perBase: null,
        };
      }
    } else {
      preview = { line: "enter qty / size / uom to preview", dim: null, perBase: null };
    }
  }

  const readyToSave = catchWeight ? perLbValid : qtyValid && sizeValid && !!UOM_TO_BASE[uom];

  async function save() {
    if (busy || !readyToSave) return;
    setBusy(true);
    setError(null);
    setLastTwins(null);
    const body: Record<string, unknown> = {
      itemId: item.id,
      catchWeight,
      billedUnit: billedUnit.trim() || null,
      note: note.trim() || null,
    };
    if (catchWeight) {
      body.perLb = perLb;
    } else {
      body.qty = qty;
      body.size = size;
      body.uom = uom;
    }
    const r = await postJson("/api/review/set-pack-override", body);
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    const d = (r.data ?? {}) as { twins?: number; perBase?: number | null };
    const twins = d.twins ?? 0;
    setLastTwins(twins);
    toast(
      twins > 0
        ? `Saved: pack override (applied to ${fmtCount(twins + 1)} matching items)`
        : "Saved: pack override"
    );
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Pack override">
      <header className="kf-drawer__block-head">
        <h4>Pack size (override)</h4>
        <small>
          structured override: qty + size + uom OR $/lb for catch-weight. Writes
          <code> pack_state=&apos;override&apos;</code> and propagates to same-SKU twins.
        </small>
      </header>

      <div className="kf-dpn__row">
        <div className="kf-dpn__toggle">
          <label className="kf-dpn__toggle-label">
            <input
              type="checkbox"
              checked={catchWeight}
              aria-label="Priced by the pound (catch-weight)"
              onChange={(e) => {
                const v = e.currentTarget.checked;
                setCatchWeight(v);
              }}
              disabled={busy}
            />
            <span>Priced by the pound (catch-weight)</span>
          </label>
          <div className="kf-dpn__hint">
            Catch-weight items are billed by actual shipped weight. The $/lb below is used
            directly; qty/size/uom are ignored.
          </div>
        </div>
      </div>

      {catchWeight ? (
        <div className="kf-dpn__row">
          <label className="kf-dpn__label">
            <span>$ / lb</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={perLbStr}
              onChange={(e) => setPerLbStr(e.target.value)}
              placeholder="e.g. 5.299"
            />
          </label>
        </div>
      ) : (
        <>
          <div className="kf-dpn__row kf-newing__row">
            <label className="kf-dpn__label">
              <span>Qty</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min="0"
                value={qtyStr}
                onChange={(e) => setQtyStr(e.target.value)}
                placeholder="e.g. 6"
              />
            </label>
            <label className="kf-dpn__label">
              <span>Size</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={sizeStr}
                onChange={(e) => setSizeStr(e.target.value)}
                placeholder="e.g. 5"
              />
            </label>
            <label className="kf-dpn__label">
              <span>UOM</span>
              <select value={uom} onChange={(e) => setUom(e.target.value)}>
                {UOM_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o} value={o}>
                        {o === "FLOZ" ? "FL OZ" : o}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>

          <div className="kf-dpn__row">
            <div className="kf-dpn__hint">
              Case price on file: {previewCasePrice ? (
                <strong>{fmtUsd(previewCasePrice.v)} ({previewCasePrice.src})</strong>
              ) : (
                <span className="kf-muted">none - pack will save, per-unit will be blank</span>
              )}
            </div>
          </div>
        </>
      )}

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Billed unit (optional)</span>
          <input
            type="text"
            value={billedUnit}
            onChange={(e) => setBilledUnit(e.target.value)}
            placeholder={item.billedUnit ?? "case / lb / each"}
          />
        </label>
        <label className="kf-dpn__label">
          <span>Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. confirmed with vendor rep"
          />
        </label>
      </div>

      <div className="kf-dpn__row kf-dpn__preview-row">
        <div className="kf-dpn__preview" aria-live="polite">
          <span className="kf-dpn__preview-label">Preview</span>
          <span className={`kf-dpn__preview-body${preview.dim === "no-price" ? " kf-dpn__preview-body--warn" : ""}`}>
            {preview.line}
          </span>
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
            disabled={busy || !readyToSave}
            onClick={save}
          >
            {busy ? "Saving..." : "Save override"}
          </button>
          <SaveFlash savedAt={savedAt} error={error} />
        </div>
        {lastTwins != null && lastTwins > 0 ? (
          <div className="kf-dpn__hint">
            Applied to <strong>{fmtCount(lastTwins + 1)}</strong> matching items (same vendor SKU).
          </div>
        ) : null}
      </div>
    </section>
  );
}
