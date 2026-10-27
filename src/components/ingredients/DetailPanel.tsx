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
import { X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";
import type { ReviewCardIngredient, ReviewGroupItem } from "./ReviewCard";
import "./drawer.css";

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
}: {
  open: Exclude<DetailPanelOpen, null>;
  onClose: () => void;
  ingredient: ReviewCardIngredient;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
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
            {open.kind === "item" && item ? item.displayName : ingredient.name}
          </h3>
          <div className="kf-drawer__chips">
            {ingredient.category ? (
              <span className="kf-pill kf-pill--muted">{ingredient.category}</span>
            ) : (
              <span className="kf-pill kf-pill--warn">Needs category</span>
            )}
            {ingredient.parent ? (
              <span className="kf-pill kf-pill--muted">{ingredient.parent}</span>
            ) : null}
            {ingredient.resale ? <span className="kf-pill kf-pill--muted">Resale</span> : null}
          </div>
        </div>

        {open.kind === "item" && item ? (
          <ItemFacts item={item} />
        ) : null}

        <IngredientBlock
          ingredient={ingredient}
          parentOptions={parentOptions}
          parents={parents}
          onDone={() => router.refresh()}
        />

        {open.kind === "item" && item ? (
          <PackOverrideBlock item={item} onDone={() => router.refresh()} />
        ) : null}
      </aside>
    </>
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
            {item.pack ?? <span className="kf-muted">-</span>}
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
            {item.catalogPrice != null ? (
              <>
                {fmtUsd(item.catalogPrice)}
                <span className="kf-cell-sub"> catalog</span>
              </>
            ) : item.unitPrice != null ? (
              <>
                {fmtUsd(item.unitPrice)}
                <span className="kf-muted"> /{item.unitPriceUnit ?? "unit"}</span>
                <span className="kf-cell-sub"> billed, latest</span>
              </>
            ) : (
              <span className="kf-muted">-</span>
            )}
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

  const [superDraft, setSuperDraft] = useState<string>(ingredient.category ?? "");
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(ingredient.parent ?? "");
  const [subNew, setSubNew] = useState("");
  const [catBusy, setCatBusy] = useState(false);

  const [resaleBusy, setResaleBusy] = useState(false);

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
    const r = await postJson("/api/review/rename-ingredient", {
      ingredientId: ingredient.id,
      newName: next,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Rename failed (${r.status})`), { tone: "block" });
      setRenameBusy(false);
      return;
    }
    const d = r.data as { aliasWritten?: boolean };
    toast(
      d.aliasWritten
        ? `Renamed - old name kept as an alias so links survive`
        : `Renamed`
    );
    setRenameBusy(false);
    onDone();
  }

  async function doCategory() {
    if (catBusy) return;
    const nextSuper: SuperCategory | null = superDraft === "" ? null : (superDraft as SuperCategory);
    const nextSub =
      subMode === "new" ? subNew.trim() || null : (subPick === "" ? null : subPick);
    setCatBusy(true);
    const r = await postJson("/api/review/set-category", {
      ingredientId: ingredient.id,
      category: nextSuper,
      parent: nextSub,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Save failed (${r.status})`), { tone: "block" });
      setCatBusy(false);
      return;
    }
    toast(nextSuper ? `Set to ${nextSuper}` : "Marked as Needs category");
    setCatBusy(false);
    onDone();
  }

  async function toggleResale(next: boolean) {
    if (resaleBusy) return;
    setResaleBusy(true);
    const r = await postJson("/api/review/set-resale", {
      ingredientId: ingredient.id,
      resale: next,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Save failed (${r.status})`), { tone: "block" });
      setResaleBusy(false);
      return;
    }
    toast(next ? "Moved to resale bucket" : "Moved to recipe-coverage bucket");
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
            Save name
          </button>
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
            Save category
          </button>
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
          </label>
          <div className="kf-dpn__hint">
            Resale items (bottled water, disposables) are tracked but excluded from recipe-coverage.
          </div>
        </div>
      </div>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Merge into another ingredient</span>
          <select
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            disabled={mergeBusy || mergeChoices.length === 0}
          >
            <option value="">Pick a survivor...</option>
            {mergeChoices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.parent ? ` - ${p.parent}` : ""}
              </option>
            ))}
          </select>
        </label>
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
            Merge into chosen
          </button>
        </div>
      </div>
    </section>
  );
}

function PackOverrideBlock({
  item,
  onDone,
}: {
  item: ReviewGroupItem;
  onDone: () => void;
}) {
  const [packText, setPackText] = useState(item.pack ?? "");
  const [billedUnit, setBilledUnit] = useState(item.billedUnit ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    const next = packText.trim();
    if (next.length < 1) { toast("Pack text is required", { tone: "block" }); return; }
    setBusy(true);
    const r = await postJson("/api/review/set-pack-override", {
      itemId: item.id,
      packText: next,
      billedUnit: billedUnit.trim() || null,
      note: note.trim() || null,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast("Pack size saved");
    setBusy(false);
    onDone();
  }

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Pack override">
      <header className="kf-drawer__block-head">
        <h4>Pack size</h4>
        <small>fills missing pack size; marked as manually entered</small>
      </header>

      <div className="kf-dpn__row">
        <label className="kf-dpn__label">
          <span>Pack text</span>
          <input
            type="text"
            value={packText}
            onChange={(e) => setPackText(e.target.value)}
            placeholder="e.g. 4/10lb or 24/16oz"
          />
        </label>
        <label className="kf-dpn__label">
          <span>Billed unit</span>
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
            placeholder="e.g. confirmed with vendor rep 10/27"
          />
        </label>
        <div className="kf-dpn__hint">
          Normalized $/lb across pack sizes comes later (step 3 pack parsing). This saves the
          human-attested pack as-is.
        </div>
        <div className="kf-dpn__btns">
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
            disabled={busy || packText.trim().length < 1}
            onClick={save}
          >
            Save pack
          </button>
        </div>
      </div>
    </section>
  );
}
