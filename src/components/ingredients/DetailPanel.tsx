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
import { AlertTriangle, Check, ChevronDown, Info, X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong, timeAgo } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import { CAN10_LB_PER_UNIT, canonicalFromBaseUnit, convertPer } from "@/lib/ingredients/pack";
import { IngredientAllergens } from "./IngredientAllergens";
import { humanizeKind } from "@/lib/humanizeKind";
import { IngredientTypeahead } from "./IngredientTypeahead";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";
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
    // Lock the page behind the modal panel; restore whatever it was.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
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
                {ingredient.resale ? <span className="kf-pill kf-pill--muted">Retail</span> : null}
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
          <ItemPanelBody item={item} ingredient={ingredient} onDone={() => router.refresh()} />
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
      label: "Retail",
      body: <>Moved to <strong>{next ? "retail bucket" : "recipe coverage"}</strong></>,
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
                ) : item.perBaseConfidence === "derived" ? (
                  <span className="kf-facts__note">from spend</span>
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

  // B1: allergen state + handlers moved to the shared
  // IngredientAllergens component (used here AND in the workbench's
  // MasterDetail pane). The component owns selection, Confirm
  // enablement, save, and router.refresh. See IngredientAllergens.tsx.
  // S1: live counts for the "Also moves N confirmed items" hint.
  // Fetched once on mount per ingredient; refreshed after a save so
  // the next toggle shows the new state.
  const [resalePreview, setResalePreview] = useState<{ active: number; resale: number } | null>(null);
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
        setResalePreview({
          active: Number(data.confirmedActive ?? 0),
          resale: Number(data.confirmedResale ?? 0),
        });
      } catch {
        /* non-fatal; hint stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingredient.id, resaleSavedAt]);

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
    const d = (r.data ?? {}) as { moved?: number };
    const moved = d.moved ?? 0;
    const base = next ? "Saved: moved to retail bucket" : "Saved: moved to recipe-coverage bucket";
    const direction = next ? "to retail" : "back to active";
    toast(
      moved > 0
        ? `${base} (${fmtCount(moved)} confirmed items moved ${direction})`
        : base
    );
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
          The old name is kept as an alias, so linked items stay linked.
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
              aria-label="Mark as retail"
              onChange={(e) => {
                const v = e.currentTarget.checked;
                toggleResale(v);
              }}
              disabled={resaleBusy}
            />
            <span>Retail (not a recipe ingredient)</span>
            <SaveFlash savedAt={resaleSavedAt} error={resaleError} />
          </label>
          <div className="kf-dpn__hint">
            Retail items (bottled water, disposables) are tracked but excluded from recipe-coverage.
            {resalePreview
              ? ingredient.resale
                ? resalePreview.resale > 0
                  ? ` Unticking also moves ${fmtCount(resalePreview.resale)} confirmed item${resalePreview.resale === 1 ? "" : "s"} back into the working set.`
                  : ""
                : resalePreview.active > 0
                  ? ` Ticking also moves ${fmtCount(resalePreview.active)} confirmed item${resalePreview.active === 1 ? "" : "s"} out of the working set.`
                  : ""
              : ""}
          </div>
        </div>
      </div>

      {/* B1 (allergens): shared pill grid + Confirm, same component
          the MasterDetail pane renders. Both surfaces are now driven
          by one source of truth; see IngredientAllergens.tsx. */}
      <div className="kf-dpn__row">
        <IngredientAllergens
          ingredientId={ingredient.id}
          allergens={ingredient.allergens}
          reviewedBy={ingredient.allergens_reviewed_by}
          reviewedAt={ingredient.allergens_reviewed_at}
          onSaved={onDone}
        />
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
          Its items and confirmed links move to the ingredient you choose. &ldquo;{ingredient.name}&rdquo;
          is kept as a merged record and its name becomes an alias, so the matcher routes the old
          name here automatically. Undoable from Recent decisions.
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${mergeBusy ? " is-busy" : ""}`}
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
  { label: "Weight", options: ["LB", "OZ", "G", "KG", "CAN10"] },
  { label: "Volume", options: ["FLOZ", "GAL", "QT", "L", "ML", "PT"] },
  { label: "Count", options: ["EA", "CT", "DZ", "PC"] },
];
const UOM_TO_BASE: Record<string, { base: "LB" | "FLOZ" | "EA"; factor: number }> = {
  LB: { base: "LB", factor: 1 },
  OZ: { base: "LB", factor: 1 / 16 },
  G: { base: "LB", factor: 1 / 453.592 },
  KG: { base: "LB", factor: 2.20462 },
  // U1: #10 can treated as a weight unit; the shared factor is in
  // pack.ts (CAN10_LB_PER_UNIT) so client preview and server estimate
  // never drift.
  CAN10: { base: "LB", factor: CAN10_LB_PER_UNIT },
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
// Display label for the UOM dropdown. CAN10 is a user-facing option
// but the token is a code; render it as "#10 can" in the <select>
// and anywhere the chosen uom is echoed back on the Result row.
function uomDisplay(u: string): string {
  if (u === "FLOZ") return "FL OZ";
  if (u === "CAN10") return "#10 can";
  return u;
}

// S5: convert a $-per-dim-base number into $-per-master-unit for the
// item panel's Result + Read-as rows. The master list already converts
// per_base -> master.base_unit for display (IngredientMasters.tsx via
// the same convertPer / canonicalFromBaseUnit helpers in pack.ts);
// without this, a gallon-costed master shows $298.75/gal while the
// item panel reads $2.33/fl oz for the same price, and the user
// reads it as "my edit did not take". Fallbacks:
//   - no linked ingredient         -> dim-base label (today's behavior)
//   - master base_unit not canonical -> dim-base label
//   - cross-dimension (verdict's "won't blend") -> dim-base label
// Only the LABEL and the DISPLAYED VALUE change here; nothing writes
// anywhere.
function displayPerBase(
  perBaseInDim: number,
  dimBase: "LB" | "FLOZ" | "EA",
  ingredient: ReviewCardIngredient | null,
): { value: number; label: string } {
  if (!ingredient) return { value: perBaseInDim, label: UOM_LABEL[dimBase] };
  const target = canonicalFromBaseUnit(ingredient.base_unit);
  if (!target) return { value: perBaseInDim, label: UOM_LABEL[dimBase] };
  const converted = convertPer(perBaseInDim, dimBase, target);
  if (converted == null) return { value: perBaseInDim, label: UOM_LABEL[dimBase] };
  return { value: converted, label: ingredient.base_unit };
}

// Billed unit = how the VENDOR charged for the line, which decides which
// price tier fires:
//   a base unit  -> Tier A / Tier B use the invoice price directly
//   a container  -> the case-price tier divides by the pack size
// A value the engine does not recognise falls through to the container
// branch silently and the item's price ends up divided by its pack.
// Mirrors BASE_BILLED in src/lib/intake.ts and normUom in pack.ts; the
// server re-validates against ALLOWED_BILLED_UNITS.
const BILLED_UNIT_GROUPS: { label: string; options: string[] }[] = [
  { label: "Priced per unit - price used as-is", options: ["lb", "oz", "each", "gallon", "count", "dozen"] },
  { label: "Priced per container - price divided by pack", options: ["case", "bag", "box", "pack", "jar", "can", "other"] },
];

// Map an ingredient's base_unit (R1 vocabulary) to the base UOM
// dimension the pack editor emits. Used by the Result row's verdict
// to say whether the edit will actually make the item join the blend.
const INGREDIENT_BASE_TO_UOM: Record<string, "LB" | "FLOZ" | "EA"> = {
  lb: "LB",
  each: "EA",
  gal: "FLOZ",
  dozen: "EA",
};

// Parse the server's packNormalized ("50 LB" or "6/1 LB") back into
// qty/size/uom so the "Read as" row can show the total conversion.
function parsePackNormalized(
  s: string | null
): { qty: number; size: number; uom: string } | null {
  if (!s) return null;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*\/\s*)?(\d+(?:\.\d+)?)\s+([A-Z ]+)$/);
  if (!m) return null;
  const qty = m[1] ? Number(m[1]) : 1;
  const size = Number(m[2]);
  const uom = m[3].trim().toUpperCase().replace(/\s+/g, "");
  if (!Number.isFinite(qty) || !Number.isFinite(size) || qty <= 0 || size <= 0) return null;
  return { qty, size, uom };
}

// Hint from the Attention section to the pack chain: set a UOM,
// focus Qty, scroll the Result row into view. nonce changes on each
// click so the effect fires even when the UOM stays the same.
type PackHint = { uom: string; nonce: number };

// $/base plausibility bands. Mirrors IngredientMasters.tsx:62-69 - a
// hit is a soft "look here", not a hard assertion. Kept local to keep
// S2's diff within DetailPanel + drawer.css per spec acceptance 7.
// If a third file needs this later, extract to a shared module in
// one commit.
const PACK_BANDS: Record<string, { low: number; high: number }> = {
  LB: { low: 0.5, high: 100 },
  OZ: { low: 0.03, high: 6 },
  FLOZ: { low: 0.01, high: 5 },
  GAL: { low: 1, high: 200 },
  EA: { low: 0.1, high: 25 },
  DZ: { low: 1, high: 60 },
};

// Exact-cents currency for the Evidence Extended column. fmtUsd rounds
// to $5K at amounts >= $1000; fmtUsdLong rounds to the dollar. Neither
// lets a human check 273 x $21.44 against $4,504.50.
function fmtUsdCents(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function PackOverrideBlock({
  item,
  ingredient,
  hint,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  hint: PackHint | null;
  onDone: () => void;
}) {
  // S2: pre-fill qty/size/uom from the item's own stored pack so
  // correcting one field is one keystroke, not a retype. When
  // packNormalized does not parse, fields stay blank.
  const seededPack = parsePackNormalized(item.packNormalized);
  // U1: when the parser tagged this item as a #10 can (raw pack text
  // carries "#10"), pre-select "#10 can" as the Change-to UOM so the
  // common fix is one confirm. qty + size come from seededPack
  // unchanged - the parser already emits qty=caseCount, size=1 for
  // these - we only swap the uom from the parser's symbolic "CT" to
  // the weight-dimension CAN10 so the Result math produces $/lb.
  // UI suggestion only: no stored data is rewritten; the user still
  // has to confirm.
  const can10Hint = /#10\b/.test(item.pack ?? "");
  const [catchWeight, setCatchWeight] = useState<boolean>(item.catchWeight);
  // S4: tracks whether the user has toggled the mode button. Toggling
  // is an edit for display purposes (the chain switches to recomputed
  // from a different formula), so it must flip showStored off.
  const [catchWeightEdited, setCatchWeightEdited] = useState<boolean>(false);
  const [qtyStr, setQtyStr] = useState<string>(seededPack ? String(seededPack.qty) : "");
  const [sizeStr, setSizeStr] = useState<string>(seededPack ? String(seededPack.size) : "");
  const [uom, setUom] = useState<string>(
    can10Hint
      ? "CAN10"
      : seededPack?.uom && UOM_TO_BASE[seededPack.uom]
        ? seededPack.uom
        : "LB"
  );
  const qtyInputRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  // Fix-the-pack hint from Attention: set UOM, focus Qty, scroll
  // Result into view. Does NOT prefill qty/size - the user supplies
  // the number. nonce avoids stale-closure skips.
  useEffect(() => {
    if (!hint) return;
    setCatchWeight(false);
    setCatchWeightEdited(true);
    setUom(hint.uom);
    qtyInputRef.current?.focus();
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [hint?.nonce, hint?.uom]);
  // Display seed only: two decimals, like every other money field. What
  // the user types is what saves - this does not touch the write.
  const [perLbStr, setPerLbStr] = useState<string>(
    item.perBase != null && item.catchWeight ? Number(item.perBase).toFixed(2) : ""
  );
  const [billedUnit, setBilledUnit] = useState<string>(item.billedUnit ?? "");
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTwins, setLastTwins] = useState<number | null>(null);

  // S4: case-price source. Three options now (catalog, billed, avg)
  // and the default is the source that produced the stored per_base,
  // not the S2 ">25% disagreement" rule. When the stored source is an
  // averaged tier (actuals_*), surface the engine's case figure as an
  // "invoice average" option so the dropdown can honestly reproduce
  // the saved price. Falls back to the S2 bigGap heuristic only when
  // the item has no stored source (new / unpriced).
  const catalogV =
    item.catalogPrice != null && item.catalogPrice > 0 ? item.catalogPrice : null;
  const billedV = item.unitPrice != null && item.unitPrice > 0 ? item.unitPrice : null;
  const avgV =
    item.caseSource != null && item.caseSource.startsWith("actuals_") &&
    item.storedCasePrice != null && item.storedCasePrice > 0
      ? item.storedCasePrice
      : null;
  const bigGap =
    catalogV != null && billedV != null
      ? Math.abs(catalogV - billedV) / Math.max(catalogV, billedV) > 0.25
      : false;
  // Which source produced the stored per_base? Used both to default
  // the dropdown and to decide whether the Result row shows the
  // stored figure (showStored below).
  const storedSrc: "catalog" | "billed" | "avg" | null =
    item.caseSource === "catalog"
      ? "catalog"
      : item.caseSource === "billed"
        ? "billed"
        : item.caseSource != null && item.caseSource.startsWith("actuals_")
          ? "avg"
          : null;
  const defaultCaseSrc: "catalog" | "billed" | "avg" | null =
    storedSrc ??
    (bigGap ? "billed" : catalogV != null ? "catalog" : billedV != null ? "billed" : null);
  const [caseSrc, setCaseSrc] = useState<"catalog" | "billed" | "avg" | null>(defaultCaseSrc);
  const previewCasePrice =
    caseSrc === "catalog" && catalogV != null
      ? { v: catalogV, src: "catalog" as const }
      : caseSrc === "billed" && billedV != null
        ? { v: billedV, src: "billed" as const }
        : caseSrc === "avg" && avgV != null
          ? { v: avgV, src: "avg" as const }
          : catalogV != null
            ? { v: catalogV, src: "catalog" as const }
            : billedV != null
              ? { v: billedV, src: "billed" as const }
              : avgV != null
                ? { v: avgV, src: "avg" as const }
                : null;

  const qty = Number(qtyStr);
  const size = Number(sizeStr);
  const perLb = Number(perLbStr);
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const sizeValid = Number.isFinite(size) && size > 0;
  const perLbValid = Number.isFinite(perLb) && perLb > 0;

  // Pristine check: the entered pack still equals the stored one.
  // Save pack stays disabled when nothing has changed so pre-filling
  // never writes an unchanged pack back as a human-set override.
  const packPristine =
    !!seededPack &&
    qtyValid &&
    sizeValid &&
    Number(seededPack.qty) === qty &&
    Number(seededPack.size) === size &&
    seededPack.uom === uom;
  const perLbPristine =
    item.perBase != null &&
    item.catchWeight &&
    perLbValid &&
    Math.abs(Number(item.perBase) - perLb) < 0.005;

  // S4: show the item's SAVED per_base in the Result row (and the
  // Read-as derived tail, and the band check) when nothing has moved
  // yet - pack inputs are at their seeded values, the mode has not
  // been toggled, and the case-price dropdown is still on the source
  // that produced the stored price. The master list reads the stored
  // price; the panel must agree with it on open. Rotating the
  // dropdown to a different source puts the chain into "what-if"
  // mode and the recomputed figure takes over - rotating back to the
  // stored source restores the stored figure.
  const chainPristine =
    !catchWeight &&
    packPristine &&
    !catchWeightEdited &&
    caseSrc === storedSrc;
  const showStored =
    chainPristine &&
    item.perBase != null &&
    item.perBaseUom != null;

  // Live preview math - mirrors estimateFromOverride for a client-side
  // display BEFORE the save; the server re-does the math from the same
  // table so there's no drift risk.
  let preview: { line: string; dim: string | null; perBase: number | null; baseLabel: string | null } = {
    line: "",
    dim: null,
    perBase: null,
    baseLabel: null,
  };
  if (catchWeight) {
    if (perLbValid) {
      // Catch-weight is weight-dim; displayPerBase converts LB ->
      // ingredient.base_unit when linked (lb master is a no-op; cross
      // dim is impossible in practice because catch-weight only exists
      // on meat/produce, but the helper falls back cleanly).
      const disp = displayPerBase(perLb, "LB", ingredient);
      preview = {
        line: `${fmtUsd(disp.value)} / ${disp.label} (catch-weight)`,
        dim: "weight",
        perBase: disp.value,
        baseLabel: disp.label,
      };
    } else {
      preview = { line: "enter $/lb to preview", dim: null, perBase: null, baseLabel: null };
    }
  } else {
    if (qtyValid && sizeValid && uom && UOM_TO_BASE[uom]) {
      const b = UOM_TO_BASE[uom];
      const total = qty * size * b.factor;
      if (previewCasePrice) {
        // Compute perBase in the DIMENSION base (what the backfill
        // writes to price_estimate.per_base and what the server stamps
        // on save), then convert for DISPLAY only. The pack-total
        // echo on the left of "->" stays in the dim-base unit because
        // it is a math echo of the pack ("6 x 1 GAL = 768.00 fl oz"),
        // not a price display.
        const perBaseInDim = previewCasePrice.v / total;
        const disp = displayPerBase(perBaseInDim, b.base, ingredient);
        preview = {
          line: `${qty} x ${size} ${uomDisplay(uom)} = ${total.toFixed(2)} ${UOM_LABEL[b.base]} -> ${fmtUsd(disp.value)} / ${disp.label}  (case ${fmtUsd(previewCasePrice.v)} ${previewCasePrice.src})`,
          dim: "math",
          perBase: disp.value,
          baseLabel: disp.label,
        };
      } else {
        preview = {
          line: `${qty} x ${size} ${uomDisplay(uom)} = ${total.toFixed(2)} ${UOM_LABEL[b.base]}  (no case price on file - per-unit will be blank)`,
          dim: "no-price",
          perBase: null,
          baseLabel: UOM_LABEL[b.base],
        };
      }
    } else {
      preview = { line: "enter qty / size / uom to preview", dim: null, perBase: null, baseLabel: null };
    }
  }

  // S4 + S5: on pristine open override preview.perBase with the item's
  // SAVED per_base, converted to the MASTER's unit via displayPerBase
  // so the headline reads $/gal (lb/each/dozen) and agrees with the
  // master list. Without the conversion S4 would re-introduce the
  // "$2.33 / fl oz" display S5 fixed. The sub tag says "saved" so the
  // user knows this isn't a recomputation. storedBaseLabel is kept as
  // the dim-base fallback for items that are unlinked or whose
  // perBaseUom isn't one of the three canonical bases.
  const storedBaseLabel =
    item.perBaseUom === "LB"
      ? "lb"
      : item.perBaseUom === "FLOZ"
        ? "fl oz"
        : item.perBaseUom === "EA"
          ? "each"
          : item.perBaseUom?.toLowerCase() ?? null;
  if (showStored && item.perBase != null && storedBaseLabel != null && seededPack) {
    const packStr =
      seededPack.qty === 1
        ? `${seededPack.size} ${seededPack.uom}`
        : `${seededPack.qty} x ${seededPack.size} ${seededPack.uom}`;
    const canonical =
      item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA"
        ? displayPerBase(item.perBase, item.perBaseUom, ingredient)
        : { value: item.perBase, label: storedBaseLabel };
    preview = {
      line: `${packStr} - saved per-unit from ${item.caseSource ?? "stored estimate"}`,
      dim: "math",
      perBase: canonical.value,
      baseLabel: canonical.label,
    };
  }

  // S2: band check on the price per the USER's chosen uom - not the
  // normalized base. Avocado-oil 1x1 GAL at $298.75 normalizes to
  // $2.33/fl oz which falls inside the FLOZ band; it is $298.75/gal
  // which falls outside the GAL band. The user is thinking in gallons,
  // so we band in gallons. Soft warning only, no save-block.
  //
  // S4: on pristine open, band-check the stored price (converted into
  // the user's declared uom) rather than a recomputed hypothetical.
  // Out-of-band saves should fire the warning on open too.
  const userUom = catchWeight ? "LB" : uom && UOM_TO_BASE[uom] ? uom : null;
  const band = userUom ? PACK_BANDS[userUom] : null;
  let pricePerUserUom: number | null = catchWeight
    ? perLbValid ? perLb : null
    : qtyValid && sizeValid && previewCasePrice
      ? previewCasePrice.v / (qty * size)
      : null;
  if (showStored && item.perBase != null && userUom && UOM_TO_BASE[userUom]) {
    pricePerUserUom = item.perBase * UOM_TO_BASE[userUom].factor;
  }
  const outOfBand =
    pricePerUserUom != null && band != null &&
    (pricePerUserUom < band.low || pricePerUserUom > band.high);
  // Suggest a "case of N" fix. Try common case sizes first (6, 4, 12,
  // 2, 24, 3, 8) because N=2 lands "in band" trivially for anything
  // just-over the band; the common sizes are more likely to be what
  // OCR actually dropped. The 6/1 GAL avocado oil must suggest 6,
  // not 2.
  const COMMON_CASE_SIZES = [6, 4, 12, 2, 24, 3, 8, 5, 10];
  let bandCaseHint: { n: number; perUnit: number } | null = null;
  if (outOfBand && pricePerUserUom != null && band) {
    for (const n of COMMON_CASE_SIZES) {
      const candidate = pricePerUserUom / n;
      if (candidate >= band.low && candidate <= band.high) {
        bandCaseHint = { n, perUnit: candidate };
        break;
      }
    }
  }

  // S6: moving the Case-price dropdown counts as a change, so a user
  // who ONLY picks "billed" (keeping the pack) can save. The save
  // routes to the A2.1 price-override path in save() below (durable;
  // the backfill skips pack_override.price_only). Catch-weight path
  // is unchanged - it has no case-price dropdown.
  const caseSrcChanged = caseSrc !== defaultCaseSrc;
  // S7: flipping the mode toggle counts as a change too. Shrimp live
  // example: fixed 4x5 LB case stored catch_weight=true, so the
  // catch-weight tier wrote the case total ($172.99) as $/lb. Flip
  // to "priced by the case" with no other edit must save and re-cost
  // via the normal pack path (172.99 / 20 = $8.65/lb). Compare
  // against item.catchWeight so toggling off then back on nets to
  // "no change" and leaves Save disabled.
  const catchWeightChanged = catchWeight !== (item.catchWeight ?? false);
  const readyToSave =
    (catchWeight
      ? perLbValid && !perLbPristine
      : qtyValid && sizeValid && !!UOM_TO_BASE[uom] && (!packPristine || caseSrcChanged || catchWeightChanged));

  async function save() {
    if (busy || !readyToSave) return;
    setBusy(true);
    setError(null);
    setLastTwins(null);

    // S6: pack pristine + ONLY the case-price source moved -> write a
    // durable price override through A2.1's /set-price-override. This
    // is the branch where the user picked catalog-vs-billed in the
    // dropdown and clicked save; before S6 the pristine-pack check
    // would have left Save disabled, and even bypassing that the
    // pack-override route recomputes case price catalog-first and
    // discards the pick. Reuses setVendorItemPriceOverride (writes
    // pack_override.price_only, which the backfill skips). When the
    // user changed BOTH the pack and the case source, the pack
    // override wins - one save, one effect, no double-write.
    // S7: also skip when the toggle flipped - a mode change needs a
    // pack-override recompute (new tier), not a price pin. Same "one
    // save, one effect" rule.
    if (!catchWeight && packPristine && caseSrcChanged && !catchWeightChanged && previewCasePrice) {
      const b = UOM_TO_BASE[uom];
      const total = qty * size * b.factor;
      const perBaseInDim = previewCasePrice.v / total;
      const srcLabel = previewCasePrice.src;
      const userNote = note.trim();
      const auto = `Costed from ${srcLabel} case price ${fmtUsd(previewCasePrice.v)} instead of the default`;
      const reason = userNote ? `${auto}. ${userNote}` : auto;
      const r = await postJson("/api/review/set-price-override", {
        itemId: item.id,
        perBase: perBaseInDim,
        baseUom: b.base,
        reason,
      });
      if (!r.ok) {
        const msg = errMsg(r.data, `Save failed (${r.status})`);
        setError(msg);
        toast(msg, { tone: "block" });
        setBusy(false);
        return;
      }
      const d = (r.data ?? {}) as { twins?: number };
      const twins = d.twins ?? 0;
      setLastTwins(twins);
      toast(
        twins > 0
          ? `Saved: price override (applied to ${fmtCount(twins + 1)} matching items)`
          : "Saved: price override"
      );
      setSavedAt(Date.now());
      setBusy(false);
      onDone();
      return;
    }

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

  // "Read as" row: dynamic label + body.
  // override         -> "Set by hand"
  // perBase=null+parse failed -> "Could not read" (with perBaseNote underneath when present)
  // otherwise        -> "Read as"
  const parsedBack = parsePackNormalized(item.packNormalized);
  const readAsLabel =
    item.packState === "override"
      ? "Set by hand"
      : item.perBase == null
        ? "Could not read"
        : "Read as";
  // S2: append the derived $/unit so the Read-as row answers the
  // question "is the existing pack already fine?". Uses the SAME
  // case-price source the Result row uses (previewCasePrice) so the
  // two numbers can be compared directly.
  let readAsBody: string;
  if (parsedBack) {
    const b = UOM_TO_BASE[parsedBack.uom];
    const total = b ? parsedBack.qty * parsedBack.size * b.factor : null;
    const base = total != null && b
      ? parsedBack.qty === 1
        ? `${parsedBack.size} ${uomDisplay(parsedBack.uom)} = ${total.toFixed(2)} ${UOM_LABEL[b.base]}`
        : `${parsedBack.qty} x ${parsedBack.size} ${uomDisplay(parsedBack.uom)} = ${total.toFixed(2)} ${UOM_LABEL[b.base]}`
      : item.packNormalized ?? item.pack ?? "(not available)";
    // S4 + S5: showStored branch displays the item's stored per-unit
    // when the chain is pristine; the else branch recomputes from the
    // user's entry. BOTH branches route through displayPerBase so the
    // Read-as line reads in the MASTER's unit (gal/lb/each/dozen) and
    // agrees with the master list - without the conversion S4 would
    // re-introduce the "$2.33 / fl oz" display S5 fixed. The left
    // side of "->" stays in dim-base because it is a math echo of
    // the pack, not a price.
    let derived = "";
    if (
      showStored &&
      item.perBase != null &&
      (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA")
    ) {
      const disp = displayPerBase(item.perBase, item.perBaseUom, ingredient);
      derived = ` -> ${fmtUsd(disp.value)} / ${disp.label}`;
    } else if (total != null && total > 0 && b && previewCasePrice) {
      const disp = displayPerBase(previewCasePrice.v / total, b.base, ingredient);
      derived = ` -> ${fmtUsd(disp.value)} / ${disp.label}`;
    } else if (total != null && b && !previewCasePrice) {
      derived = " -> no price";
    }
    readAsBody = base + derived;
  } else {
    readAsBody = item.packNormalized ?? item.pack ?? "(not available)";
  }

  // Result row: derived $/unit + verdict against the ingredient's base_unit.
  const ingredientBase = ingredient ? INGREDIENT_BASE_TO_UOM[ingredient.base_unit?.toLowerCase() ?? ""] ?? null : null;
  const enteredBase = catchWeight ? "LB" : uom && UOM_TO_BASE[uom] ? UOM_TO_BASE[uom].base : null;
  let verdict: { tone: "good" | "block"; text: string } | null = null;
  if (ingredient && ingredientBase && enteredBase && readyToSave) {
    if (enteredBase === ingredientBase) {
      verdict = {
        tone: "good",
        text: `Matches ${ingredient.name} - this item joins the blend.`,
      };
    } else {
      const baseWord =
        enteredBase === "LB" ? "lb" : enteredBase === "FLOZ" ? "fl oz" : "each";
      const ingBaseWord = ingredient.base_unit?.toLowerCase() ?? "its unit";
      verdict = {
        tone: "block",
        text: `${ingredient.name} is costed per ${ingBaseWord}. In ${baseWord} it still will not blend.`,
      };
    }
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Pack size">
      <header className="kf-drawer__block-head">
        <h4>Pack size</h4>
        <small>
          How the invoice reads it, what to change it to, and whether the result will join the
          blend. Copies to twins with the same item number.
        </small>
      </header>

      {/* Mode switch - decides which `Change to` controls render below.
          aria-pressed on each button; corp floor via .kf-chain__mode-btn. */}
      <div className="kf-chain__mode" role="group" aria-label="Pricing mode">
        <button
          type="button"
          className={`kf-chain__mode-btn${!catchWeight ? " is-on" : ""}`}
          aria-pressed={!catchWeight}
          onClick={() => { setCatchWeight(false); setCatchWeightEdited(true); }}
          disabled={busy}
        >
          Priced by the case
        </button>
        <button
          type="button"
          className={`kf-chain__mode-btn${catchWeight ? " is-on" : ""}`}
          aria-pressed={catchWeight}
          onClick={() => { setCatchWeight(true); setCatchWeightEdited(true); }}
          disabled={busy}
        >
          Catch weight - priced by actual weight
        </button>
      </div>

      <div className="kf-chain">
        {/* Row 1 - Invoice says: verbatim pack text in a mono chip. */}
        <div className="kf-chain__row">
          <div className="kf-chain__label">Invoice says</div>
          <div className="kf-chain__value">
            <code className="kf-chain__mono">{item.pack ?? "(none)"}</code>
          </div>
        </div>

        {/* Row 2 - Read as / Set by hand / Could not read. */}
        <div className="kf-chain__row">
          <div className="kf-chain__label">{readAsLabel}</div>
          <div className="kf-chain__value">
            <span>{readAsBody}</span>
            {readAsLabel === "Could not read" && item.perBaseNote ? (
              <span className="kf-chain__sub">{item.perBaseNote}</span>
            ) : null}
          </div>
        </div>

        {/* Row 3 - Change to: inputs. Shape depends on mode. */}
        <div className="kf-chain__row kf-chain__row--input">
          <div className="kf-chain__label">Change to</div>
          <div className="kf-chain__value">
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
                    disabled={busy}
                  />
                </label>
              </div>
            ) : (
              <div className="kf-dpn__row kf-newing__row">
                <label className="kf-dpn__label">
                  <span>Qty</span>
                  <input
                    ref={qtyInputRef}
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="0"
                    value={qtyStr}
                    onChange={(e) => setQtyStr(e.target.value)}
                    placeholder="e.g. 6"
                    disabled={busy}
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
                    disabled={busy}
                  />
                </label>
                <label className="kf-dpn__label">
                  <span>UOM</span>
                  <select value={uom} onChange={(e) => setUom(e.target.value)} disabled={busy}>
                    {UOM_GROUPS.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.options.map((o) => (
                          <option key={o} value={o}>
                            {uomDisplay(o)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="kf-dpn__row kf-newing__row">
              <label className="kf-dpn__label">
                <span>Billed unit (optional)</span>
                <select
                  value={billedUnit}
                  onChange={(e) => setBilledUnit(e.target.value)}
                  disabled={busy}
                >
                  <option value="">(not set)</option>
                  {billedUnit !== "" &&
                    !BILLED_UNIT_GROUPS.some((g) => g.options.includes(billedUnit)) && (
                      <option value={billedUnit}>{billedUnit} (existing)</option>
                    )}
                  {BILLED_UNIT_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="kf-dpn__label">
                <span>Note (optional)</span>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. confirmed with vendor rep"
                  disabled={busy}
                />
              </label>
            </div>
            {!catchWeight ? (
              <div className="kf-chain__caseprice">
                <span className="kf-chain__caseprice-label">Case price</span>
                {(() => {
                  // S4: options come from whatever the item carries. The
                  // engine's own case figure ("invoice average") joins
                  // catalog and billed when the stored source was an
                  // actuals_* tier - without it the dropdown would hide
                  // the number that produced the saved per_base.
                  const options: Array<{ src: "catalog" | "billed" | "avg"; label: string; v: number }> = [];
                  if (catalogV != null) options.push({ src: "catalog", label: `${fmtUsd(catalogV)} - catalog`, v: catalogV });
                  if (billedV != null) options.push({ src: "billed", label: `${fmtUsd(billedV)} - billed, latest invoice line`, v: billedV });
                  if (avgV != null) options.push({ src: "avg", label: `${fmtUsd(avgV)} - invoice average`, v: avgV });
                  if (options.length >= 2) {
                    return (
                      <>
                        <select
                          className="kf-dt__unitsel"
                          value={caseSrc ?? options[0].src}
                          onChange={(e) =>
                            setCaseSrc(e.target.value as "catalog" | "billed" | "avg")
                          }
                          disabled={busy}
                        >
                          {options.map((o) => (
                            <option key={o.src} value={o.src}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {bigGap ? (
                          <span className="kf-chain__caseprice-note">
                            catalog and billed disagree by more than 25%
                          </span>
                        ) : null}
                      </>
                    );
                  }
                  if (options.length === 1) {
                    return <strong>{options[0].label}</strong>;
                  }
                  return <span className="kf-muted">none - pack will save, per-unit will be blank</span>;
                })()}
              </div>
            ) : null}
          </div>
        </div>

        {/* Row 4 - Result: derived $/unit + verdict. */}
        <div ref={resultRef} className="kf-chain__row kf-chain__row--result">
          <div className="kf-chain__label">Result</div>
          <div className="kf-chain__value">
            {preview.perBase != null ? (
              <strong className="kf-chain__big">
                {/* S4 + S5: label reads from preview.baseLabel, which
                    the preview-building block above sets to the
                    master's unit (via displayPerBase) in both the
                    showStored branch and the recompute branches. One
                    source of truth for the headline label. */}
                {fmtUsd(preview.perBase)} / {preview.baseLabel ?? "unit"}
              </strong>
            ) : (
              <strong className="kf-chain__big kf-muted">- / unit</strong>
            )}
            <span
              className={`kf-chain__sub${
                preview.dim === "no-price" ? " kf-chain__sub--warn" : ""
              }`}
            >
              {preview.line}
            </span>
            {/* The price is a separate fact from the pack. Key off the
                price flag directly - !packManualOverride suppressed
                this line on merged rows that had both (A2.2 fix).
                S5: convert the hand-set per_base into the master's
                unit via displayPerBase so this line agrees with the
                Result headline and the master list - without it the
                "set by hand" chip reads /fl oz on a gal master. */}
            {item.priceManualOverride && item.perBase != null && (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA") ? (() => {
              const disp = displayPerBase(item.perBase, item.perBaseUom, ingredient);
              return (
                <span className="kf-chain__sub">
                  Price set by hand - {fmtUsd(disp.value)} / {disp.label}
                </span>
              );
            })() : null}
            {verdict ? (
              <span className={`kf-chain__verdict kf-chain__verdict--${verdict.tone}`}>
                {verdict.text}
              </span>
            ) : null}
            {outOfBand && pricePerUserUom != null && band && userUom ? (
              <span className="kf-chain__verdict kf-chain__verdict--warn">
                {fmtUsd(pricePerUserUom)}/{userUom.toLowerCase()}{" "}
                is far outside the usual range for per-{userUom.toLowerCase()} ingredients.
                {bandCaseHint
                  ? ` Check the pack - a case of ${bandCaseHint.n} would make this ${fmtUsd(bandCaseHint.perUnit)}/${userUom.toLowerCase()}.`
                  : " Check the pack."}
              </span>
            ) : null}
            <div className="kf-dpn__btns">
              <button
                type="button"
                className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
                disabled={busy || !readyToSave}
                onClick={save}
              >
                {/* S6: label follows the action. Pack pristine + source
                    moved -> price-override write ("Save price"). Any
                    other save path ("Save pack") keeps today's label.
                    S7: a toggle flip is a pack save (recompute), so
                    the label stays "Save pack" even when caseSrc
                    also moved - matches the save-routing guard. */}
                {busy
                  ? "Saving..."
                  : !catchWeight && packPristine && caseSrcChanged && !catchWeightChanged
                    ? "Save price"
                    : "Save pack"}
              </button>
              <SaveFlash savedAt={savedAt} error={error} />
            </div>
            {lastTwins != null && lastTwins > 0 ? (
              <div className="kf-dpn__hint">
                Applied to <strong>{fmtCount(lastTwins + 1)}</strong> matching items (same vendor SKU).
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

// Direct per-base price override. Sits BELOW the pack chain on
// purpose - the pack is the cause, this is the symptom, and the
// ordering nudges toward fixing the cause. See
// setVendorItemPriceOverride for backfill-durability caveat.
// G1: the item's grade tier. Plainly a QUALITY classification, not a
// price field - held separately from the pack-chain + price-override
// blocks per the spec pin ("The control is plainly a quality tier,
// not a price field. Do not label it with a dollar sign or put it
// next to the price override."). Null is standard; 'premium' is the
// only sanctioned non-null value today. The write writes only
// pr_vendor_items.grade and emits one pr_events row with before AND
// after populated (the fix for the ledger-audit gap discovered
// 2026-11-04).
function ItemGradeBlock({
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

function PriceOverrideBlock({
  item,
  ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const router = useRouter();
  // Default baseUom to the ingredient's base_unit when there is one,
  // else to the item's existing perBaseUom, else LB. All three are
  // valid first picks; LB is the dominant case.
  const ingBase = ingredient
    ? INGREDIENT_BASE_TO_UOM[ingredient.base_unit?.toLowerCase() ?? ""] ?? null
    : null;
  const seedBaseUom =
    ingBase ??
    (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA"
      ? item.perBaseUom
      : "LB");

  const [perBaseStr, setPerBaseStr] = useState<string>(
    item.perBase != null ? Number(item.perBase).toFixed(4) : ""
  );
  const [baseUom, setBaseUom] = useState<"LB" | "FLOZ" | "EA">(seedBaseUom);
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const perBaseN = Number(perBaseStr);
  const perBaseValid = Number.isFinite(perBaseN) && perBaseN > 0;
  const reasonValid = reason.trim().length > 0;
  const readyToSave = perBaseValid && reasonValid;

  async function save() {
    if (busy || !readyToSave) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/review/set-price-override", {
      itemId: item.id,
      perBase: perBaseN,
      baseUom,
      reason: reason.trim(),
    });
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    toast("Saved: price override");
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
    router.refresh();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Price override">
      <header className="kf-drawer__block-head">
        <h4>Price override</h4>
        <small>
          Use this when the pack is right and the number is not. Fixing the pack above corrects
          the cause; this one covers the symptom.
        </small>
      </header>

      <div className="kf-dpn__row kf-newing__row">
        <label className="kf-dpn__label">
          <span>$ per unit</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0"
            value={perBaseStr}
            onChange={(e) => setPerBaseStr(e.target.value)}
            placeholder="e.g. 0.73"
            disabled={busy}
          />
        </label>
        <label className="kf-dpn__label">
          <span>Unit</span>
          <select
            value={baseUom}
            onChange={(e) => setBaseUom(e.target.value as "LB" | "FLOZ" | "EA")}
            disabled={busy}
          >
            <option value="LB">pound (lb)</option>
            <option value="FLOZ">fluid ounce (fl oz)</option>
            <option value="EA">each</option>
          </select>
        </label>
      </div>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Reason (required)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. vendor-confirmed, invoice pricing error"
            disabled={busy}
          />
        </label>
      </div>

      <div className="kf-dpn__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy || !readyToSave}
          onClick={save}
        >
          {busy ? "Saving..." : "Save price"}
        </button>
        <SaveFlash savedAt={savedAt} error={error} />
      </div>
    </section>
  );
}

// ===================================================================
// A3b: What needs attention + Evidence, around the Fix-this-item blocks
// ===================================================================

type AttentionIssue =
  | { kind: "no_price"; tone: "bad"; head: string; body: string; fix?: "pack" }
  | { kind: "pack_unreadable"; tone: "info"; head: string; body: string; fix: "pack" }
  | { kind: "unit_mismatch"; tone: "bad"; head: string; body: string; fix: "pack"; targetUom: string }
  | { kind: "pack_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "price_hand_set"; tone: "warn"; head: string; body: string }
  | { kind: "no_ingredient"; tone: "info"; head: string; body: string };

const UOM_BASE_DIM: Record<string, "weight" | "volume" | "count"> = {
  LB: "weight",
  FLOZ: "volume",
  EA: "count",
};
const INGREDIENT_BASE_DIM: Record<string, "weight" | "volume" | "count"> = {
  lb: "weight",
  each: "count",
  dozen: "count",
  gal: "volume",
};
const INGREDIENT_BASE_UOM: Record<string, "LB" | "FLOZ" | "EA"> = {
  lb: "LB",
  each: "EA",
  dozen: "EA",
  gal: "FLOZ",
};

function deriveAttention(
  item: ReviewGroupItem,
  ingredient: ReviewCardIngredient | null
): AttentionIssue[] {
  const issues: AttentionIssue[] = [];

  // Pack provenance notes - stated as warn, not errors.
  if (item.packManualOverride) {
    issues.push({
      kind: "pack_hand_set",
      tone: "warn",
      head: "Pack is set by hand",
      body: "The qty / size / UOM on this item came from a human override. The backfill will not touch it.",
    });
  }
  if (item.priceManualOverride) {
    issues.push({
      kind: "price_hand_set",
      tone: "warn",
      head: "Price is set by hand",
      body: "The $ / unit on this item came from a human override and persists across backfills.",
    });
  }

  if (!ingredient) {
    issues.push({
      kind: "no_ingredient",
      tone: "info",
      head: "Not linked to an ingredient",
      body: "This item has not been confirmed into an ingredient. The Review queue is the usual path for that.",
    });
  }

  // Unit mismatch (item side only - see spec acceptance 5): we only
  // claim this when the ingredient has a known base dimension AND the
  // item's own uom resolves to a different one.
  const ingBase = ingredient ? INGREDIENT_BASE_DIM[ingredient.base_unit?.toLowerCase() ?? ""] : null;
  const itemBase = item.perBaseUom ? UOM_BASE_DIM[item.perBaseUom] : null;
  if (ingBase && itemBase && itemBase !== ingBase && ingredient) {
    const targetUom = INGREDIENT_BASE_UOM[ingredient.base_unit?.toLowerCase() ?? ""] ?? "EA";
    issues.push({
      kind: "unit_mismatch",
      tone: "bad",
      head: `Priced in ${itemBase}, ingredient is ${ingBase}`,
      body: `${ingredient.name} is costed per ${ingredient.base_unit}. This item will not blend until the pack is corrected to match.`,
      fix: "pack",
      targetUom,
    });
  }

  // Could-not-read: show the parser's note. Only emit when it has
  // something to say, otherwise no_price covers it.
  if (item.perBase == null && item.perBaseNote) {
    issues.push({
      kind: "pack_unreadable",
      tone: "info",
      head: "Pack could not be read",
      body: item.perBaseNote,
      fix: "pack",
    });
  }

  // No price at all: the primary failure. Always paired with pack_unreadable
  // when the parser left a note; still worth stating plainly.
  if (item.perBase == null) {
    issues.push({
      kind: "no_price",
      tone: "bad",
      head: "No per-unit price yet",
      body: "This item carries 12-month spend but no $ / unit, so every recipe cost that depends on it is wrong by this item's share.",
      fix: "pack",
    });
  }

  return issues;
}

// Default UOM for the "Fix the pack" button when the issue itself
// does not pin one: the linked ingredient's base unit beats LB,
// because that is the dimension the panel is trying to join.
function fixPackDefaultUom(ingredient: ReviewCardIngredient | null): string {
  if (!ingredient) return "LB";
  return INGREDIENT_BASE_UOM[ingredient.base_unit?.toLowerCase() ?? ""] ?? "LB";
}

function AttentionIcon({ tone }: { tone: "bad" | "warn" | "info" | "good" }) {
  if (tone === "good") return <Check size={16} strokeWidth={1.75} aria-hidden />;
  if (tone === "info") return <Info size={16} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />;
}

function AttentionSection({
  item,
  ingredient,
  onFixPack,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onFixPack: (uom: string) => void;
}) {
  const issues = deriveAttention(item, ingredient);
  const clear = issues.length === 0;
  // Open unless the only state is "clear" (collapsed by design) and
  // unless the only issues are provenance warnings (they are not
  // actionable; let Kevin expand if curious). But if ANY real issue
  // exists, open on load.
  const hasBad = issues.some((i) => i.tone === "bad");
  const hasInfo = issues.some((i) => i.tone === "info" && i.kind !== "no_ingredient");
  const defaultOpen = hasBad || hasInfo;
  const [open, setOpen] = useState<boolean>(defaultOpen);

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="What needs attention">
      <button
        type="button"
        className="kf-attn__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={`kf-attn__chev${open ? " is-open" : ""}`}
        />
        <h4 className="kf-attn__title">What needs attention</h4>
        <span className="kf-attn__count">{clear ? "clear" : `${issues.length}`}</span>
      </button>
      {open ? (
        <div className="kf-attn__body">
          {clear ? (
            <div className="kf-attn__note kf-attn__note--good">
              <AttentionIcon tone="good" />
              <div>
                <b>Nothing flagged</b>
                <span>This item has a price in the master&rsquo;s unit, with no override on either the pack or the number.</span>
              </div>
            </div>
          ) : (() => {
            // S2: multiple issues can resolve to the same "Fix the pack"
            // action - render the button once, on the most severe one.
            // Priority: bad > info > warn (bad is the one Kevin
            // actually acts on; info/warn stay as context).
            const toneRank: Record<string, number> = { bad: 3, info: 2, warn: 1 };
            const fixCandidates = issues.filter((i) => "fix" in i && i.fix === "pack");
            fixCandidates.sort((a, b) => (toneRank[b.tone] ?? 0) - (toneRank[a.tone] ?? 0));
            const buttonKind = fixCandidates[0]?.kind ?? null;
            return issues.map((issue) => (
              <div key={issue.kind} className={`kf-attn__note kf-attn__note--${issue.tone}`}>
                <AttentionIcon tone={issue.tone} />
                <div>
                  <b>{issue.head}</b>
                  <span>{issue.body}</span>
                  {issue.kind === buttonKind ? (
                    <button
                      type="button"
                      className="kf-btn kf-btn--line kf-btn--sm kf-attn__fix"
                      onClick={() =>
                        onFixPack(
                          "targetUom" in issue
                            ? (issue as { targetUom: string }).targetUom
                            : fixPackDefaultUom(ingredient)
                        )
                      }
                    >
                      Fix the pack
                    </button>
                  ) : null}
                </div>
              </div>
            ));
          })()}
        </div>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------------
// Evidence - lazy-loaded on first expand. Fetches /api/review/item-evidence.
// -------------------------------------------------------------------

type EvidenceInvoiceLine = {
  date: string | null;
  site: string;
  qty: number | null;
  unitPrice: number | null;
  extended: number | null;
  billedUnit: string | null;
  weightLineValue: number | null;
};
type EvidenceBySite = {
  site: string;
  lines: number;
  spend: number;
  lastPaid: number | null;
  lastBuy: string | null;
};
type EvidenceSibling = {
  id: string;
  name: string;
  vendor: string;
  pack: string | null;
  perBase: number | null;
  perBaseUom: string | null;
  usd12m: number;
};
type EvidenceVariant = { name: string; count: number };
type EvidencePayload = {
  catchWeight: boolean;
  invoiceLines: EvidenceInvoiceLine[];
  bySite: EvidenceBySite[];
  siblings: EvidenceSibling[];
  variants: EvidenceVariant[];
};

function EvidenceSection({ item }: { item: ReviewGroupItem }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ready"; data: EvidencePayload }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  // Which item id's fetch has been kicked off. The effect cannot read
  // `state.phase` as a dep: it mutates state.phase to "loading", which
  // retriggers itself, cancels the in-flight request, and the whole
  // thing stays stuck on "Loading..." - verified live on step-1 before
  // this fix. Keep deps narrow and track "already requested" out of
  // band in a ref. Item change (new id) naturally refetches because
  // requestedFor stays on the OLD id until the new effect runs.
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open || requestedFor.current === item.id) return;
    requestedFor.current = item.id;
    let cancelled = false;
    // Only keep the ref set when the request actually succeeded.
    // Three stall cases the first ref-only fix left:
    //   1. collapsed mid-flight -> cleanup fires cancelled=true,
    //      fetch short-circuits, ref stays pointing at this id,
    //      reopen is cached-not-done forever.
    //   2. fetch returned !ok -> error state renders, ref stays,
    //      no retry on reopen.
    //   3. fetch threw -> same as 2.
    // Track completion with `done`; cleanup clears the ref when it
    // was abandoned, and the error branches clear it inline so a
    // reopen refetches rather than showing a permanent error.
    let done = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/review/item-evidence?id=${encodeURIComponent(item.id)}`);
        const data = (await res.json().catch(() => null)) as EvidencePayload | { error?: string } | null;
        if (cancelled) return;
        if (!res.ok || !data || "error" in data) {
          const msg =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `Fetch failed (${res.status})`;
          requestedFor.current = null;
          setState({ phase: "error", message: msg });
          done = true;
          return;
        }
        setState({ phase: "ready", data: data as EvidencePayload });
        done = true;
      } catch (e) {
        if (cancelled) return;
        requestedFor.current = null;
        setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        done = true;
      }
    })();
    return () => {
      cancelled = true;
      // Abandoned mid-flight: let the next open refetch.
      if (!done) requestedFor.current = null;
    };
  }, [open, item.id]);

  const summary =
    state.phase === "ready"
      ? `${fmtCount(state.data.invoiceLines.length)} line${state.data.invoiceLines.length === 1 ? "" : "s"} · ${fmtCount(state.data.bySite.length)} site${state.data.bySite.length === 1 ? "" : "s"}`
      : "";

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Evidence">
      <button
        type="button"
        className="kf-attn__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={`kf-attn__chev${open ? " is-open" : ""}`}
        />
        <h4 className="kf-attn__title">Evidence</h4>
        <span className="kf-attn__count">{summary || "expand to load"}</span>
      </button>
      {open ? (
        <div className="kf-evidence">
          {state.phase === "loading" ? (
            <div className="kf-muted">Loading...</div>
          ) : state.phase === "error" ? (
            <div className="kf-attn__note kf-attn__note--bad">
              <AttentionIcon tone="bad" />
              <div>
                <b>Could not load evidence</b>
                <span>{state.message}</span>
              </div>
            </div>
          ) : state.phase === "ready" ? (
            <EvidenceBody data={state.data} highlightItemId={item.id} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EvidenceBody({
  data,
  highlightItemId,
}: {
  data: EvidencePayload;
  highlightItemId: string;
}) {
  return (
    <>
      {data.invoiceLines.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Invoice lines</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Site</th>
                  <th className="kf-evi__num">{data.catchWeight ? "Billed weight" : "Qty"}</th>
                  <th className="kf-evi__num">{data.catchWeight ? "$ / lb" : "Unit $"}</th>
                  <th className="kf-evi__num">Extended</th>
                </tr>
              </thead>
              <tbody>
                {data.invoiceLines.map((l, i) => (
                  <tr key={i}>
                    <td>{fmtDate(l.date, "short")}</td>
                    <td>{l.site}</td>
                    <td className="kf-evi__num">
                      {data.catchWeight
                        ? l.weightLineValue != null
                          ? `${l.weightLineValue.toFixed(2)} lb`
                          : "-"
                        : l.qty != null
                          ? fmtCount(l.qty)
                          : "-"}
                    </td>
                    <td className="kf-evi__num">
                      {l.unitPrice != null ? fmtUsdCents(l.unitPrice) : "-"}
                    </td>
                    <td className="kf-evi__num">
                      {l.extended != null ? fmtUsdCents(l.extended) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.bySite.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Spend by site</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Site</th>
                  <th className="kf-evi__num">Lines</th>
                  <th className="kf-evi__num">Spend</th>
                  <th className="kf-evi__num">Last paid</th>
                  <th>Last buy</th>
                </tr>
              </thead>
              <tbody>
                {data.bySite.map((s) => (
                  <tr key={s.site}>
                    <td>{s.site}</td>
                    <td className="kf-evi__num">{fmtCount(s.lines)}</td>
                    <td className="kf-evi__num">{fmtUsd(s.spend)}</td>
                    <td className="kf-evi__num">{s.lastPaid != null ? fmtUsd(s.lastPaid) : "-"}</td>
                    <td>{fmtDate(s.lastBuy, "short")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.siblings.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Other items on this ingredient</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Pack</th>
                  <th className="kf-evi__num">Per-unit</th>
                  <th className="kf-evi__num">Annual $</th>
                </tr>
              </thead>
              <tbody>
                {data.siblings.map((s) => (
                  <tr key={s.id} className={s.id === highlightItemId ? "kf-evi__row--self" : undefined}>
                    <td title={s.name}>
                      <div className="kf-cell-strong kf-cell-ellipsis">{s.vendor}</div>
                      <div className="kf-cell-sub kf-cell-ellipsis">{s.name}</div>
                    </td>
                    <td>{s.pack ?? "-"}</td>
                    <td className="kf-evi__num">
                      {s.perBase != null ? (
                        <>
                          <strong>{fmtUsd(s.perBase)}</strong>
                          <span className="kf-muted">
                            {" "}
                            / {s.perBaseUom === "LB" ? "lb" : s.perBaseUom === "FLOZ" ? "fl oz" : s.perBaseUom === "EA" ? "each" : s.perBaseUom ?? "unit"}
                          </span>
                        </>
                      ) : (
                        <span className="kf-muted">-</span>
                      )}
                    </td>
                    <td className="kf-evi__num">{fmtUsd(s.usd12m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.variants.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Description variants</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="kf-evi__num">Lines (12m)</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((v) => (
                  <tr key={v.name}>
                    <td>{v.name}</td>
                    <td className="kf-evi__num">{fmtCount(v.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Composite that wires Attention + Pack + Price + Evidence together,
// holding the shared pack-hint state the Attention "Fix the pack"
// button writes into and the Pack chain reads.
function ItemPanelBody({
  item,
  ingredient,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  onDone: () => void;
}) {
  const [packHint, setPackHint] = useState<PackHint | null>(null);
  return (
    <>
      <AttentionSection
        item={item}
        ingredient={ingredient}
        onFixPack={(uom) => setPackHint({ uom, nonce: Date.now() })}
      />
      <PackOverrideBlock item={item} ingredient={ingredient} hint={packHint} onDone={onDone} />
      <PriceOverrideBlock item={item} ingredient={ingredient} onDone={onDone} />
      <EvidenceSection item={item} />
    </>
  );
}
