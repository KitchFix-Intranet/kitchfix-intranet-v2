"use client";

// N12: Ingredients tab = one workspace. Toolbar + two panes filling
// the window below the shell's top bar (desktop) or stacked with a
// phone back-link (<=860). The detail pane is composed from the item
// panel's primitives (kf-ipanel__*):
//   - .kf-ipanel__strip      -> stats strip
//   - .kf-ipanel__attn       -> IssueNote block (+ --good variant)
//   - PanelIngredientZone    -> Name / Category / Costed per / One
//                               each is / Allergens
//   - PanelClosedRows        -> Mark as retail / Merge / Send all
//                               back / Change history
// There is ONE each-measure editor (PanelIngredientZone's "One each
// is" row), ONE BaseUnitControl mount (inside PanelIngredientZone),
// ONE allergen block (inside PanelIngredientZone). The drawer the
// name used to open (IngredientPanelById) is deleted along with its
// chrome="tab" code paths in BaseUnitControl and IngredientAllergens.
//
// Vocabulary: user-facing "master" / "masters" -> "ingredient" /
// "ingredients" everywhere on this tab (N12 §R8). The IdentBand's
// fact labels in IngredientMasters.tsx are a separate ask.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Search,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { ItemPanelById } from "./ItemPanelById";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { uomLabel } from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/measures";
import { RowSendBackButton } from "./RowSendBackButton";
import { RowGradeToggle } from "./RowGradeToggle";
import { PanelIngredientZone } from "./panel/PanelIngredientZone";
import { PanelClosedRows } from "./panel/PanelClosedRows";
import type { ReviewCardIngredient } from "./itemTypes";
import "./ingredients-tab.css";

// Typed issue surface (ingredient has at least one of these set by
// IngredientMasters.tsx server rollup). "empty" is "no linked items";
// kept here for the badge + filter chip, even though the price
// sub-line already names coverage/spread.
export type MasterIssue = "spread" | "coverage" | "mismatch" | "outlier" | "band" | "empty";

export type LensStats = {
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  pricedCount: number;
  linkedCount: number;
  usd12m: number;
  unpricedUsd: number;
};

export type MasterLinkedItem = {
  id: string;
  name: string;
  vendor: string;
  perBase: number | null;
  perBaseUom: string | null;
  unitMismatch: boolean;
  outlier: boolean;
  priceManualOverride: boolean;
  grade: string | null;
  usd12m: number;
  eachMeasure: { qty: number; uom: string } | null;
};

export type MasterRow = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  baseUnit: string;
  resale: boolean;
  allergens: string[];
  allergensReviewedBy: string | null;
  allergensReviewedAt: string | null;
  linkedCount: number;
  usd12m: number;
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  statsByLens: {
    blended: LensStats;
    standard: LensStats;
    premium: LensStats;
  };
  baseUom: string | null;
  flagged: boolean;
  flagReason: string | null;
  pricedCount: number;
  unpricedUsd: number;
  issues: MasterIssue[];
  suggestedBaseUnit: string | null;
  medianBeforeExclusion: number | null;
  linkedItems: MasterLinkedItem[];
  eachMeasureQty: number | null;
  eachMeasureUom: string | null;
  eachMeasureSource: string | null;
};

type SortMode = "spend" | "name" | "links" | "spread";

const SORT_LABEL: Record<SortMode, string> = {
  spend: "Highest spend",
  name: "Name A to Z",
  links: "Most items",
  spread: "Widest spread",
};

// N12 §R8 + §2b: badges for what the price sub-line cannot say.
// "spread" / "coverage" are dropped - price sub-line names both.
// "empty" renamed "No items"; "mismatch" renamed "Mixed units".
const ISSUE_BADGE: Partial<Record<MasterIssue, string>> = {
  mismatch: "Mixed units",
  outlier: "Outlier",
  band: "Out of band",
  empty: "No items",
};

const BASE_UNIT_WORD: Record<string, string> = {
  lb: "lb", ea: "each", gal: "gal", dozen: "dozen", oz: "oz", kg: "kg", g: "g",
};

function uomOrUnit(uom: string | null): string {
  return uom ? uomLabel(uom) : "unit";
}

// N12 round 2 fix 14: $0.00 reads as noise next to the pane head's
// "- a year"; prefer "$0". fmtUsd stays untouched for other callers.
function fmtMoney(n: number): string {
  return n === 0 ? "$0" : fmtUsd(n);
}

function matches(row: MasterRow, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (row.name.toLowerCase().includes(n)) return true;
  if (row.parent && row.parent.toLowerCase().includes(n)) return true;
  if (row.category && row.category.toLowerCase().includes(n)) return true;
  for (const li of row.linkedItems) {
    if (li.name.toLowerCase().includes(n)) return true;
    if (li.vendor.toLowerCase().includes(n)) return true;
  }
  return false;
}

// N12 §R1: price-sub precedence on the row. First match wins.
function rowPriceSub(row: MasterRow): { text: string; warn: boolean } | null {
  if (row.linkedCount === 0) return null;
  if (row.pricedCount === 0) return { text: "not priced", warn: true };
  if (row.pricedCount < row.linkedCount) {
    return { text: `${fmtCount(row.pricedCount)} of ${fmtCount(row.linkedCount)} priced`, warn: true };
  }
  if (row.spreadRatio != null && row.spreadRatio > 3) {
    return { text: `${row.spreadRatio.toFixed(1)}x spread`, warn: true };
  }
  if (row.baseUnit === "each" && row.eachMeasureQty != null && row.avgPerBase != null) {
    const derived = deriveRecipePrice({
      perBase: row.avgPerBase,
      perBaseUom: "EA",
      itemMeasure: null,
      ingredientMeasure: { qty: row.eachMeasureQty, uom: (row.eachMeasureUom ?? "").toUpperCase() },
    });
    if (derived) {
      return { text: `${fmtUsd(derived.per)} / ${uomLabel(derived.uom)} in recipes`, warn: false };
    }
  }
  if (row.spreadRatio != null) {
    return { text: `${row.spreadRatio.toFixed(1)}x spread`, warn: false };
  }
  return null;
}

// Strip Price sub-line on each-costed ingredients: same derived
// figure as rowPriceSub rule 4, phrased as the render does.
function stripDerivedSub(row: MasterRow, active: LensStats): string | null {
  if (row.baseUnit !== "each" || row.eachMeasureQty == null || active.avgPerBase == null) {
    return null;
  }
  const derived = deriveRecipePrice({
    perBase: active.avgPerBase,
    perBaseUom: "EA",
    itemMeasure: null,
    ingredientMeasure: { qty: row.eachMeasureQty, uom: (row.eachMeasureUom ?? "").toUpperCase() },
  });
  return derived ? `${fmtUsd(derived.per)} / ${uomLabel(derived.uom)} in recipes` : null;
}

export function IngredientMastersFilter({
  rows,
  mode = "recipe",
}: {
  rows: MasterRow[];
  mode?: "recipe" | "resale";
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("spend");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search; Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === inputRef.current) {
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    let out = rows;
    if (trimmed) out = out.filter((r) => matches(r, trimmed));
    if (superCat !== "all") out = out.filter((r) => r.category === superCat);
    if (onlyFlagged) out = out.filter((r) => r.issues.length > 0);
    if (onlyUnreviewed) out = out.filter((r) => r.allergensReviewedAt == null);
    if (onlyEmpty) out = out.filter((r) => r.issues.includes("empty"));
    if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "links") out = [...out].sort((a, b) => b.linkedCount - a.linkedCount);
    else if (sort === "spread") out = [...out].sort((a, b) => (b.spreadRatio ?? 0) - (a.spreadRatio ?? 0));
    else out = [...out].sort((a, b) => b.usd12m - a.usd12m);
    return out;
  }, [rows, trimmed, superCat, onlyFlagged, onlyUnreviewed, onlyEmpty, sort]);

  const selected = useMemo(
    () => filtered.find((r) => r.id === selId) ?? filtered[0] ?? null,
    [filtered, selId]
  );
  const matchedUsd = useMemo(() => filtered.reduce((s, r) => s + r.usd12m, 0), [filtered]);
  const needsCount = useMemo(() => rows.filter((r) => r.issues.length > 0).length, [rows]);
  const unreviewedCount = useMemo(
    () => rows.filter((r) => r.allergensReviewedAt == null).length,
    [rows]
  );
  const emptyCount = useMemo(() => rows.filter((r) => r.issues.includes("empty")).length, [rows]);
  const totalUsd = useMemo(() => rows.reduce((s, r) => s + r.usd12m, 0), [rows]);
  const anyFilterActive =
    trimmed.length > 0 || superCat !== "all" || onlyFlagged || onlyUnreviewed || onlyEmpty;

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setOnlyFlagged(false);
    setOnlyUnreviewed(false);
    setOnlyEmpty(false);
    inputRef.current?.focus();
  }

  // When the user picks a row that lives in the filtered set, scroll
  // the list to it (nearest), ignoring vertical page scroll.
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  useEffect(() => {
    if (!selId) return;
    const el = rowRefs.current.get(selId);
    el?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  function onSelectRow(id: string) {
    setSelId(id);
    setPaneOpen(true);
  }

  // Parent options for the Category row's "pick existing" select
  // inside PanelIngredientZone (same shape the drawer provided).
  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.parent) set.add(r.parent);
    return Array.from(set).sort();
  }, [rows]);

  // Build a ReviewCardIngredient from the selected MasterRow so the
  // panel zone + closed rows read the exact shape they already do.
  const selectedIngredient: ReviewCardIngredient | null = useMemo(() => {
    if (!selected) return null;
    return {
      id: selected.id,
      name: selected.name,
      parent: selected.parent,
      category: selected.category,
      resale: selected.resale,
      base_unit: selected.baseUnit,
      allergens: selected.allergens,
      allergens_reviewed_by: selected.allergensReviewedBy,
      allergens_reviewed_at: selected.allergensReviewedAt,
      each_measure_qty: selected.eachMeasureQty,
      each_measure_uom: selected.eachMeasureUom,
      each_measure_source: selected.eachMeasureSource,
    };
  }, [selected]);

  // N12 §R2: lazy loader for Merge candidates. GET /api/review/
  // ingredient?id=<selected> returns { parents: ReviewCardIngredient[] }.
  // No fetch on selection; Merge row fires this on first expand.
  const loadParents = useCallback(async (): Promise<ReviewCardIngredient[]> => {
    if (!selected) return [];
    const res = await fetch(`/api/review/ingredient?id=${encodeURIComponent(selected.id)}`);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const data = (await res.json()) as { parents?: ReviewCardIngredient[] };
    return data.parents ?? [];
  }, [selected]);

  return (
    <div className={`kf-ingp__workspace${paneOpen ? " kf-ingp__workspace--detail-open" : ""}`}>
      {/* --- Toolbar -------------------------------------------- */}
      <div className="kf-ingp__tools">
        <label className="kf-ingp__search">
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
            }}
            placeholder={
              mode === "resale"
                ? "Filter retail by name, linked vendor or SKU"
                : "Filter by name, parent, category, linked vendor or SKU"
            }
            aria-label="Filter ingredients"
          />
          {query ? (
            <button
              type="button"
              className="kf-ingp__search-clear"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              aria-label="Clear search"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          ) : null}
        </label>

        <div className="kf-ingp__filters">
          <span className="kf-ingp__filters-label">Category</span>
          <div className="kf-chip-row" role="radiogroup" aria-label="Category filter">
            <button
              type="button"
              role="radio"
              aria-checked={superCat === "all"}
              className={`kf-chip${superCat === "all" ? " kf-chip--on" : ""}`}
              onClick={() => setSuperCat("all")}
            >
              All <span>{fmtCount(rows.length)}</span>
            </button>
            {SUPER_CATEGORIES.map((cat) => {
              const n = rows.filter((r) => r.category === cat).length;
              if (n === 0) return null;
              return (
                <button
                  key={cat}
                  type="button"
                  role="radio"
                  aria-checked={superCat === cat}
                  className={`kf-chip${superCat === cat ? " kf-chip--on" : ""}`}
                  onClick={() => setSuperCat(cat)}
                >
                  {cat} <span>{fmtCount(n)}</span>
                </button>
              );
            })}
          </div>

          <span className="kf-ingp__filters-label">Show only</span>
          <div className="kf-chip-row" role="radiogroup" aria-label="Attention filter">
            <button
              type="button"
              aria-pressed={onlyFlagged}
              className={`kf-chip kf-chip--warn${onlyFlagged ? " kf-chip--on" : ""}`}
              onClick={() => setOnlyFlagged((v) => !v)}
              title="Ingredients with a spread, coverage, unit or outlier issue"
            >
              Needs attention <span>{fmtCount(needsCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyUnreviewed}
              className={`kf-chip${onlyUnreviewed ? " kf-chip--on" : ""}`}
              onClick={() => setOnlyUnreviewed((v) => !v)}
              title="Ingredients whose Top 9 allergens have not been reviewed"
            >
              Allergens to check <span>{fmtCount(unreviewedCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyEmpty}
              className={`kf-chip${onlyEmpty ? " kf-chip--on" : ""}`}
              onClick={() => setOnlyEmpty((v) => !v)}
              title="Ingredients with no live vendor items (candidates to retire)"
            >
              No items <span>{fmtCount(emptyCount)}</span>
            </button>
            {anyFilterActive ? (
              <button
                type="button"
                className="kf-chip"
                onClick={clearAll}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- Panes --------------------------------------------- */}
      <div className={`kf-ingp__panes${paneOpen ? " kf-ingp__panes--detail-open" : ""}`}>
        {/* List pane */}
        <section className="kf-ingp__pane kf-ingp__pane--list" aria-label="Ingredient list">
          <div className="kf-ingp__list-head">
            <div className="kf-ingp__list-head-title">
              <h3>Ingredients</h3>
              <span className="kf-ingp__list-head-sub">
                {anyFilterActive ? (
                  <>
                    <b>{fmtCount(filtered.length)}</b> of <b>{fmtCount(rows.length)}</b> shown
                    {" · "}
                    <b>{fmtMoney(matchedUsd)}</b> a year
                  </>
                ) : (
                  <>
                    <b>{fmtCount(rows.length)}</b> shown · <b>{fmtMoney(totalUsd)}</b> a year
                  </>
                )}
              </span>
            </div>
            <select
              className="kf-ingp__sort"
              value={sort}
              onChange={(e) => {
                const v = e.target.value as SortMode;
                setSort(v);
              }}
              aria-label="Sort order"
            >
              <option value="spend">{SORT_LABEL.spend}</option>
              <option value="name">{SORT_LABEL.name}</option>
              <option value="links">{SORT_LABEL.links}</option>
              <option value="spread">{SORT_LABEL.spread}</option>
            </select>
          </div>

          <div className="kf-ingp__list-colhead">
            <span>Ingredient</span>
            <span>Price</span>
            <span>12 mo</span>
          </div>

          <div className="kf-ingp__pane-scroll">
            {filtered.length === 0 ? (
              <div className="kf-ingp__list-empty">
                <div className="kf-ingp__list-empty-title">No ingredients match the current filters</div>
                <div className="kf-ingp__list-empty-body">Try clearing filters, or widen the category.</div>
                <button
                  type="button"
                  className="kf-btn kf-btn--line kf-btn--sm"
                  onClick={clearAll}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <ul className="kf-ingp__list">
                {filtered.map((row) => (
                  <li key={row.id}>
                    <IngredientRow
                      row={row}
                      selected={selected?.id === row.id}
                      onSelect={() => onSelectRow(row.id)}
                      registerRef={(el) => {
                        if (el) rowRefs.current.set(row.id, el);
                        else rowRefs.current.delete(row.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Detail pane */}
        <section className="kf-ingp__pane kf-ingp__pane--detail" aria-label="Ingredient detail">
          {selected && selectedIngredient ? (
            <>
              <button
                type="button"
                className="kf-ingp__dback"
                onClick={() => setPaneOpen(false)}
              >
                ‹ All ingredients
              </button>
              <div className="kf-ingp__pane-scroll" key={selected.id}>
                <DetailView
                  row={selected}
                  ingredient={selectedIngredient}
                  parentOptions={parentOptions}
                  onDone={() => router.refresh()}
                  onLoadParents={loadParents}
                  onOpenItem={(id) => setOpenItemId(id)}
                />
              </div>
            </>
          ) : null}
        </section>
      </div>

      {openItemId ? (
        <ItemPanelById itemId={openItemId} onClose={() => setOpenItemId(null)} />
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------
// List row
// -------------------------------------------------------------------

function IngredientRow({
  row,
  selected,
  onSelect,
  registerRef,
}: {
  row: MasterRow;
  selected: boolean;
  onSelect: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}) {
  const priceSub = rowPriceSub(row);
  const badges = row.issues
    .map((k) => ({ kind: k, label: ISSUE_BADGE[k] }))
    .filter((b): b is { kind: MasterIssue; label: string } => !!b.label);

  const priceMain = row.avgPerBase != null
    ? `${fmtUsd(row.avgPerBase)} / ${uomOrUnit(row.baseUom)}`
    : `- / ${(row.baseUnit || "unit").toLowerCase()}`;

  const usdText = row.linkedCount > 0 ? fmtUsd(row.usd12m) : "-";

  return (
    <button
      ref={registerRef}
      type="button"
      className={`kf-ingp__row${row.issues.length > 0 ? " kf-ingp__row--att" : ""}${selected ? " kf-ingp__row--sel" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <div className="kf-ingp__row-name">
        <span className="kf-ingp__row-name-main">{row.name}</span>
        <span className="kf-ingp__row-sub">
          <span>
            {row.parent ?? (row.category ? row.category : "No category")}
            {row.linkedCount > 0
              ? ` · ${fmtCount(row.linkedCount)} item${row.linkedCount === 1 ? "" : "s"}`
              : ""}
          </span>
          {row.resale ? <span className="kf-ingp__row-retail">Retail</span> : null}
          {badges.map((b) => (
            <span key={b.kind} className="kf-ingp__row-badge">{b.label}</span>
          ))}
        </span>
      </div>
      <div className="kf-ingp__row-price">
        <span className="kf-ingp__row-price-main">
          {row.avgPerBase != null ? (
            <>
              <b>{fmtUsd(row.avgPerBase)}</b> / {uomOrUnit(row.baseUom)}
            </>
          ) : (
            <>- / {(row.baseUnit || "unit").toLowerCase()}</>
          )}
        </span>
        {priceSub ? (
          <span className={`kf-ingp__row-price-sub${priceSub.warn ? " kf-ingp__row-price-sub--warn" : ""}`}>
            {priceSub.text}
          </span>
        ) : null}
      </div>
      <div className="kf-ingp__row-usd" aria-label={`12-month spend ${usdText}`}>
        {usdText}
      </div>
    </button>
  );
}

// -------------------------------------------------------------------
// Detail view (head + strip + attention + zone + linked + closed)
// -------------------------------------------------------------------

function DetailView({
  row,
  ingredient,
  parentOptions,
  onDone,
  onLoadParents,
  onOpenItem,
}: {
  row: MasterRow;
  ingredient: ReviewCardIngredient;
  parentOptions: string[];
  onDone: () => void;
  onLoadParents: () => Promise<ReviewCardIngredient[]>;
  onOpenItem: (id: string) => void;
}) {
  // N12 §2c.1: vendor count = distinct vendor names in linkedItems.
  const vendorCount = useMemo(() => {
    const set = new Set<string>();
    for (const li of row.linkedItems) if (li.vendor) set.add(li.vendor);
    return set.size;
  }, [row.linkedItems]);

  const [lens, setLens] = useState<"blended" | "standard" | "premium">("blended");
  const populatedLenses = (["standard", "premium"] as const).filter(
    (k) => row.statsByLens[k].linkedCount > 0
  );
  const showLens = populatedLenses.length >= 2;
  const effectiveLens: "blended" | "standard" | "premium" = showLens ? lens : "blended";
  const active = row.statsByLens[effectiveLens];

  const uom = uomOrUnit(row.baseUom);

  const partial = active.linkedCount > 0 && active.pricedCount < active.linkedCount;
  const spreadBad = active.spreadRatio != null && active.spreadRatio > 3;

  const derivedForStrip = stripDerivedSub(row, active);

  return (
    <>
      {/* Head */}
      <div className="kf-ingp__dhead">
        <span className={`kf-ingp__dhead-eyebrow${(!row.category || !row.parent) ? " kf-ingp__dhead-eyebrow--warn" : ""}`}>
          {row.category || "Needs category"}
          {row.parent ? ` · ${row.parent}` : ""}
        </span>
        <h2>{row.name}</h2>
        <div className="kf-ingp__dhead-meta">
          <span>
            <b>{fmtCount(row.linkedCount)}</b> vendor item{row.linkedCount === 1 ? "" : "s"}
            {" · "}
            <b>{fmtCount(vendorCount)}</b> vendor{vendorCount === 1 ? "" : "s"}
          </span>
          {row.resale ? <span className="kf-ingp__row-retail">Retail</span> : null}
        </div>
      </div>

      {/* Strip - round 2 fix 9: value + unit on one line, no wrap;
          lens select below Price is the compact chrome, never
          clipped, with a 44 px click target. */}
      <div className="kf-ipanel__strip kf-ingp__dzone-strip">
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">
            {effectiveLens === "blended" ? "Price" : effectiveLens === "standard" ? "Standard price" : "Premium price"}
          </span>
          <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
            {active.avgPerBase != null ? fmtUsd(active.avgPerBase) : "-"}{" "}
            <span className="kf-ipanel__strip-value-unit">/ {uom}</span>
          </span>
          <span className="kf-ipanel__strip-sub">
            {active.pricedCount > 0
              ? `${fmtCount(active.pricedCount)} priced`
              : "no priced items"}
            {derivedForStrip ? ` · ${derivedForStrip}` : ""}
          </span>
          {showLens ? (
            <label className="kf-ingp__lens">
              <select
                value={effectiveLens}
                onChange={(e) => {
                  const v = e.target.value as "blended" | "standard" | "premium";
                  setLens(v);
                }}
                aria-label="Price lens"
              >
                <option value="blended">Blended</option>
                <option value="standard">Standard</option>
                <option value="premium">Premium</option>
              </select>
            </label>
          ) : null}
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">Spread</span>
          <span className={`kf-ipanel__strip-value${spreadBad ? "" : " kf-ipanel__strip-value--accent"}`}
                style={spreadBad ? { color: "var(--sp-block)" } : undefined}>
            {active.spreadRatio != null ? `${active.spreadRatio.toFixed(1)}x` : "-"}
          </span>
          <span className="kf-ipanel__strip-sub">
            {active.minPerBase != null && active.maxPerBase != null
              ? `${fmtUsd(active.minPerBase)} to ${fmtUsd(active.maxPerBase)}`
              : active.pricedCount < 2
                ? "needs 2 priced items"
                : "-"}
          </span>
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">Priced</span>
          <span className={`kf-ipanel__strip-value${partial ? "" : " kf-ipanel__strip-value--accent"}`}
                style={partial ? { color: "var(--sp-warn)" } : undefined}>
            {fmtCount(active.pricedCount)}{" "}
            <span className="kf-ipanel__strip-value-unit">of {fmtCount(active.linkedCount)}</span>
          </span>
          <span className="kf-ipanel__strip-sub">
            {active.linkedCount === 0
              ? "no linked items"
              : partial
                ? `${fmtCount(active.linkedCount - active.pricedCount)} item${active.linkedCount - active.pricedCount === 1 ? "" : "s"} unpriced`
                : "all items priced"}
          </span>
        </div>
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">12-mo spend</span>
          <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
            {row.linkedCount > 0 ? fmtMoney(active.usd12m) : "-"}
          </span>
          <span className="kf-ipanel__strip-sub">
            {row.linkedCount > 0
              ? `${fmtCount(row.linkedCount)} linked item${row.linkedCount === 1 ? "" : "s"}`
              : "no linked items"}
          </span>
        </div>
      </div>

      {/* Attention */}
      <div className="kf-ingp__dzone--attn-wrap">
        <IngredientAttention row={row} onDone={onDone} />
      </div>

      {/* Ingredient zone (Name / Category / Costed per / One each is / Allergens) */}
      <div className="kf-ingp__dzone">
        <PanelIngredientZone
          key={row.id}
          ingredient={ingredient}
          item={null}
          parentOptions={parentOptions}
          onDone={onDone}
        />
      </div>

      {/* Linked items */}
      <div className="kf-ingp__dzone kf-ingp__dzone--section">
        <div className="kf-ingp__dzone--section-head">
          <h3>Linked items · {fmtCount(row.linkedCount)}</h3>
          <span className="kf-ingp__dzone-sub">Click an item to open it</span>
        </div>
        {row.linkedItems.length === 0 ? (
          <div className="kf-ingp__list-empty">
            <div className="kf-ingp__list-empty-title">No vendor items</div>
            <div className="kf-ingp__list-empty-body">
              No live items are linked to this ingredient. If it is a fresh split, the matcher will
              attach items next run; otherwise it is likely ready to retire.
            </div>
          </div>
        ) : (
          <LinkedItems row={row} onOpenItem={onOpenItem} />
        )}
      </div>

      {/* Closed rows */}
      <div className="kf-ingp__dzone kf-ingp__dzone--closed">
        <PanelClosedRows
          key={row.id}
          item={null}
          ingredient={ingredient}
          parents={[]}
          onLoadParents={onLoadParents}
          sendAllBack={{
            masterName: row.name,
            itemIds: row.linkedItems.map((li) => li.id),
          }}
          onDone={onDone}
        />
      </div>
    </>
  );
}

// -------------------------------------------------------------------
// Attention block - IssueNote sentences, item-panel attn primitive
// -------------------------------------------------------------------

function IngredientAttention({ row, onDone }: { row: MasterRow; onDone: () => void }) {
  const uom = uomOrUnit(row.baseUom);
  type Issue = { lead: string; body: ReactNode };
  const issues: Issue[] = [];

  // N12 round 2 fix 13: zero-linked ingredients cannot be "flagged"
  // or "clean" against nothing. Say the no-items sentence, warn tone.
  if (row.linkedCount === 0) {
    return (
      <div className="kf-ipanel__attn" aria-label="What needs attention">
        <div className="kf-ipanel__attn-item">
          <span className="kf-ipanel__attn-icon">
            <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="kf-ipanel__attn-item-text">
            <span className="kf-ipanel__attn-item-head">No live vendor items</span>
            <span className="kf-ipanel__attn-item-body">
              No live items are linked to this ingredient. If it is a fresh split, the matcher
              will attach items next run; otherwise it is likely ready to retire.
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (row.issues.includes("spread")) {
    issues.push({
      lead: `Spread is ${row.spreadRatio?.toFixed(1)}x.`,
      body: (
        <>
          {" "}Cheapest linked item is {fmtUsd(row.minPerBase ?? 0)}/{uom}, dearest is{" "}
          {fmtUsd(row.maxPerBase ?? 0)}/{uom}. Over 3x usually means one item has a bad pack size,
          not a real price difference.
        </>
      ),
    });
  }
  if (row.issues.includes("coverage")) {
    issues.push({
      lead: `${fmtCount(row.linkedCount - row.pricedCount)} of ${fmtCount(row.linkedCount)} linked items are not in this price.`,
      body: (
        <>
          {" "}
          <strong>{fmtUsd(row.unpricedUsd)}</strong> of this ingredient&rsquo;s{" "}
          {fmtUsd(row.usd12m)} sits outside the blend - either no per-unit price at all, or a
          price in a different unit. The figure above describes {fmtCount(row.pricedCount)} item
          {row.pricedCount === 1 ? "" : "s"}, not {fmtCount(row.linkedCount)}.
        </>
      ),
    });
  }
  if (row.issues.includes("mismatch")) {
    const n = row.linkedItems.filter((li) => li.unitMismatch).length;
    // N12 round 2 fix 15: suggested base-unit printed through uomLabel
    // so "floz" reads "fl oz", not the raw column form.
    const suggested = row.suggestedBaseUnit
      ? uomLabel(row.suggestedBaseUnit) || BASE_UNIT_WORD[row.suggestedBaseUnit] || row.suggestedBaseUnit
      : null;
    issues.push({
      lead: `${fmtCount(n)} item${n === 1 ? "" : "s"} priced in a different unit.`,
      body: (
        <>
          {" "}This ingredient is costed per <strong>{uom}</strong>, but{" "}
          {n === 1 ? "an item is" : "those items are"} priced per a different dimension. Those
          numbers are not comparable and never reach the blend until the unit is fixed.
          {suggested ? (
            <>
              {" "}Most of its priced items are in <strong>{suggested}</strong>, so the ingredient
              is probably the one set wrong - it was created on the default.{" "}
              <SuggestBaseUnitLink row={row} suggestedLabel={suggested} onDone={onDone} />
            </>
          ) : null}
        </>
      ),
    });
  }
  if (row.issues.includes("outlier")) {
    const o = row.linkedItems.filter((li) => li.outlier);
    const median = row.medianBeforeExclusion;
    issues.push({
      lead: `${fmtCount(o.length)} item${o.length === 1 ? "" : "s"} excluded as outlier${o.length === 1 ? "" : "s"}.`,
      body: (
        <>
          {" "}
          {o
            .map(
              (li) =>
                `${li.name} at ${fmtUsd(li.perBase ?? 0)}/${uomLabel(li.perBaseUom)}${li.priceManualOverride ? " (set by hand)" : ""}`
            )
            .join("; ")}
          {median != null ? ` against a ${fmtUsd(median)}/${uom} median.` : "."}{" "}
          Excluded from the ingredient&rsquo;s blend; survivors give{" "}
          {row.avgPerBase != null ? `${fmtUsd(row.avgPerBase)}/${uom}` : "no blend"}.
        </>
      ),
    });
  }
  if (row.issues.includes("band")) {
    issues.push({
      lead: "Average is outside the typical band for this unit.",
      body: <> A soft signal, not an assertion - worth a look at the pack sizes.</>,
    });
  }

  if (issues.length === 0) {
    return (
      <div className="kf-ipanel__attn" aria-label="What needs attention">
        <div className="kf-ipanel__attn-item kf-ipanel__attn-item--good">
          <span className="kf-ipanel__attn-icon">
            <Check size={22} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="kf-ipanel__attn-item-text">
            <span className="kf-ipanel__attn-item-head">Nothing flagged</span>
            <span className="kf-ipanel__attn-item-body">
              All {fmtCount(row.linkedCount)} linked items carry a price, in one unit, inside the
              expected band.
            </span>
          </div>
        </div>
      </div>
    );
  }

  // N12 round 2 fix 7: one box with a summary head + <ul> of
  // per-issue lines (frames B / C). Tone = the strongest tone across
  // the issues.
  const toneRank = (k: MasterIssue): number =>
    k === "spread" || k === "outlier" ? 3 : k === "mismatch" ? 2 : 1;
  const strongestKind = [...row.issues].sort((a, b) => toneRank(b) - toneRank(a))[0];
  const tone =
    strongestKind === "spread" || strongestKind === "outlier" ? "bad" : strongestKind === "mismatch" ? "info" : "warn";

  return (
    <div className="kf-ipanel__attn" aria-label="What needs attention">
      <div className={`kf-ipanel__attn-item${tone === "bad" ? " kf-ipanel__attn-item--bad" : tone === "info" ? " kf-ipanel__attn-item--info" : ""}`}>
        <span className="kf-ipanel__attn-icon">
          <AlertTriangle size={22} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="kf-ipanel__attn-item-text">
          <span className="kf-ipanel__attn-item-head">
            {issues.length} thing{issues.length === 1 ? "" : "s"} need{issues.length === 1 ? "s" : ""} attention
          </span>
          <ul className="kf-ingp__attn-list">
            {issues.map((n) => (
              <li key={n.lead}>
                <b>{n.lead}</b>{n.body}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SuggestBaseUnitLink({
  row,
  suggestedLabel,
  onDone,
}: {
  row: MasterRow;
  suggestedLabel: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const next = row.suggestedBaseUnit;
  if (!next) return null;

  async function apply() {
    if (busy || !next) return;
    setBusy(true);
    const res = await fetch("/api/review/set-base-unit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ingredientId: row.id, baseUnit: next }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      toast(data?.error ?? `Save failed (${res.status})`, { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`Switched to ${suggestedLabel}`);
    setBusy(false);
    onDone();
  }

  return (
    <button
      type="button"
      className="kf-ingp__attn-fix"
      onClick={apply}
      disabled={busy}
    >
      {busy ? "Switching..." : `Cost this per ${suggestedLabel} instead`}
    </button>
  );
}

// -------------------------------------------------------------------
// Linked-items table
// -------------------------------------------------------------------

function LinkedItems({
  row,
  onOpenItem,
}: {
  row: MasterRow;
  onOpenItem: (id: string) => void;
}) {
  // N12 §R1 echo: lowest / highest tag among items priced in the
  // ingredient's dimension (perBaseUom === baseUom, !unitMismatch,
  // perBase != null). Need 2+; ties tag the first; no tag when
  // min === max.
  const tagMap = useMemo(() => {
    const m = new Map<string, "lowest" | "highest">();
    const inDim = row.linkedItems.filter(
      (li) => li.perBase != null && !li.unitMismatch && li.perBaseUom === row.baseUom
    );
    if (inDim.length < 2) return m;
    const sorted = [...inDim].sort((a, b) => (a.perBase ?? 0) - (b.perBase ?? 0));
    const min = sorted[0].perBase;
    const max = sorted[sorted.length - 1].perBase;
    if (min === max) return m;
    m.set(sorted[0].id, "lowest");
    m.set(sorted[sorted.length - 1].id, "highest");
    return m;
  }, [row.linkedItems, row.baseUom]);

  const base = uomOrUnit(row.baseUom);

  return (
    <table className="kf-ingp__items">
      <colgroup>
        <col />
        <col style={{ width: "150px" }} />
        <col style={{ width: "112px" }} />
        <col style={{ width: "76px" }} />
        <col style={{ width: "104px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Item</th>
          <th>Grade</th>
          <th className="kf-ingp__items-num">Price</th>
          <th className="kf-ingp__items-num">12 mo</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {row.linkedItems.map((li) => {
          const tag = tagMap.get(li.id);
          const liUom = uomLabel(li.perBaseUom);
          return (
            <tr key={li.id}>
              <td>
                <button
                  type="button"
                  className="kf-ingp__item-name"
                  onClick={() => onOpenItem(li.id)}
                >
                  {li.name}
                </button>
                <span className="kf-ingp__item-sub">
                  {li.vendor}
                  {li.unitMismatch ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        priced per {liUom || "?"}, not per {base}
                      </span>
                    </>
                  ) : null}
                  {li.outlier ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        outlier, left out of the blend
                        {li.priceManualOverride ? " · set by hand" : ""}
                      </span>
                    </>
                  ) : null}
                </span>
              </td>
              <td>
                <RowGradeToggle itemId={li.id} grade={li.grade} />
              </td>
              <td className="kf-ingp__items-num">
                <div className="kf-ingp__items-price">
                  <span>
                    {li.perBase != null ? (
                      <>
                        <b>{fmtUsd(li.perBase)}</b> / {liUom}
                      </>
                    ) : (
                      <b>- / {base}</b>
                    )}
                  </span>
                  {tag ? <span className="kf-ipanel__tag">{tag}</span> : null}
                </div>
              </td>
              <td className="kf-ingp__items-num">
                <b>{fmtUsdLong(li.usd12m)}</b>
              </td>
              <td className="kf-ingp__items-num">
                <RowSendBackButton itemId={li.id} itemName={li.name} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
