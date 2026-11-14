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
import { canonicalFromBaseUnit, uomLabel } from "@/lib/ingredients/pack";
// M2 §4B amendment 4 + part 3 fix 9: no screen imports deriveRecipePrice
// or the each-measure shapers. The alternate-unit view that the derived
// sub-line used to carry is handled by the expand's chip view switch
// (§2.6) which computes in the browser via priceInUnit.
import {
  priceInUnit,
  reachableUnits,
  type Measure,
} from "@/lib/ingredients/measures";
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
export type MasterIssue = "spread" | "coverage" | "needs_measure" | "sizes_differ" | "outlier" | "band" | "empty";

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
  // M2 §2.1/2.6: per-item status + price-in-base-unit + which units
  // the item's price reaches through the ingredient's measures.
  // Replaces unitMismatch.
  statusKind: "in_blend" | "check_it" | "needs_measure" | "sizes_differ";
  perBaseInIngUnit: number | null;
  reach: string[];
  outlier: boolean;
  priceManualOverride: boolean;
  grade: string | null;
  usd12m: number;
  eachMeasure: { qty: number; uom: string } | null;
  // M2 §4B part 3 fix 4+9: pack shape rides on the linked item so the
  // Ingredients-tab panel (same mount) can seed the Measures-block
  // suggestions and the expand's chip view switch can re-price per
  // row via priceInUnit.
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  caseWeightLb: number | null;
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
  // M2 §3.7 amendment 1: the Ingredients tab already mounts
  // PanelIngredientZone off MasterRow at ~756, so measures + yield
  // ride on the row - no new wrapper, no new /api/review/ingredient
  // fetch for the basic panel open.
  measures: Array<{ from_unit: string; qty: number; to_unit: string; source: string }>;
  yieldPct: number | null;
  yieldSource: string | null;
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
// "empty" renamed "No items".
// M2: "mismatch" renamed "needs_measure", badge "Needs a measure".
const ISSUE_BADGE: Partial<Record<MasterIssue, string>> = {
  needs_measure: "Needs a measure",
  // M2.1 fix 2: sizes_differ had no badge; row rendered with no tag.
  sizes_differ: "Sizes differ",
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
  // M2 §4B amendment 4: the "in recipes" derived sub-line moved to
  // the expand's chip view switch. Row header shows the base_unit
  // price only; alternate units via chip.
  if (row.spreadRatio != null) {
    return { text: `${row.spreadRatio.toFixed(1)}x spread`, warn: false };
  }
  return null;
}

// M2 §4B amendment 4: stripDerivedSub removed. The chip view switch
// in the expand (§2.6) replaces the "in recipes" sub-line with a
// first-class alternate-unit view computed via priceInUnit.
function stripDerivedSub(_row: MasterRow, _active: LensStats): string | null {
  return null;
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

  // T3 §2: selection stickiness. The detail pane keeps the ingredient
  // the user is working on even when a save makes its row leave the
  // active filter (e.g. "Needs attention" on, user fixes the issue,
  // the row drops out of `filtered`). While selId is in `rows` but
  // not in `filtered`, the list has no highlighted row and the
  // detail pane holds the worked-on ingredient. The highlight
  // reappears the moment the row rejoins `filtered` (or when the
  // ingredient disappears from `rows` altogether, falling through to
  // filtered[0] ?? null).
  // Release events: picking another row (onSelectRow), changing
  // search / category / a Show-only chip / sort - all of those flip
  // selId to the new row (or clear it to realign with the filter).
  const selected = useMemo(() => {
    if (selId) {
      const inFiltered = filtered.find((r) => r.id === selId);
      if (inFiltered) return inFiltered;
      const inRows = rows.find((r) => r.id === selId);
      if (inRows) return inRows;
    }
    return filtered[0] ?? null;
  }, [filtered, rows, selId]);
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

  // T3 §2: release the sticky selection whenever a filter input
  // changes. "The detail pane keeps the ingredient you are working
  // on ... It lets go when you pick another row or change search,
  // category, a Show only chip or sort." Clearing selId on these
  // flips lets the selected useMemo fall through to the natural
  // filtered[0] when the ingredient no longer fits.
  function releaseSticky() {
    setSelId(null);
  }

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setOnlyFlagged(false);
    setOnlyUnreviewed(false);
    setOnlyEmpty(false);
    releaseSticky();
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
      // M2 §4B part 2: measures + yield ride on the ingredient
      // (MasterRow already carries them via IngredientMasters).
      measures: selected.measures,
      yieldPct: selected.yieldPct,
      yieldSource: selected.yieldSource,
      // Polish round 2 fix 2: the blended lens's $ / base_unit comes
      // straight off the MasterRow (buildLensStats already computed
      // it). Attention's outlier head reads this.
      blendedAvgPerBase: selected.statsByLens.blended.avgPerBase,
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
              releaseSticky();
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
              onClick={() => { setQuery(""); releaseSticky(); inputRef.current?.focus(); }}
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
              onClick={() => { setSuperCat("all"); releaseSticky(); }}
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
                  onClick={() => { setSuperCat(cat); releaseSticky(); }}
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
              onClick={() => { setOnlyFlagged((v) => !v); releaseSticky(); }}
              title="Ingredients with a spread, coverage, unit or outlier issue"
            >
              Needs attention <span>{fmtCount(needsCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyUnreviewed}
              className={`kf-chip${onlyUnreviewed ? " kf-chip--on" : ""}`}
              onClick={() => { setOnlyUnreviewed((v) => !v); releaseSticky(); }}
              title="Ingredients whose Top 9 allergens have not been reviewed"
            >
              Allergens to check <span>{fmtCount(unreviewedCount)}</span>
            </button>
            <button
              type="button"
              aria-pressed={onlyEmpty}
              className={`kf-chip${onlyEmpty ? " kf-chip--on" : ""}`}
              onClick={() => { setOnlyEmpty((v) => !v); releaseSticky(); }}
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
                releaseSticky();
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

  // M2 §4B part 3 fix 9 + polish fix 3: chip view switch. Chips are
  // the five intent units (lb, oz, each, fl oz, gal) in that order;
  // only those reachable from the ingredient's base unit (built-in
  // same-dim + measures-bridged) render. No #10 can / g / kg / ct /
  // dozen / pc. State resets per row.id (expand remount).
  const baseCanonical = canonicalFromBaseUnit(row.baseUnit);
  const [viewUom, setViewUom] = useState<string>(baseCanonical ?? "LB");
  const reachList = useMemo<string[]>(() => {
    if (!baseCanonical) return [];
    const set = reachableUnits([baseCanonical], { measures: row.measures as Measure[] });
    const order: readonly string[] = ["LB", "OZ", "EA", "FLOZ", "GAL"];
    return order.filter((u) => set.has(u));
  }, [baseCanonical, row.measures]);

  const uom = viewUom && viewUom !== baseCanonical ? uomLabel(viewUom) : uomOrUnit(row.baseUom);

  // M2 §4B part 3 fix 9: reprice each linked item in viewUom. Skip
  // items that don't yet reach the viewUom (statusKind stays what the
  // server said; price displays as "-" with the view's unit).
  const repricedLinkedItems = useMemo(() => {
    return row.linkedItems.map((li) => {
      if (li.perBase == null || li.perBaseUom == null) {
        return { ...li, viewPrice: null as number | null };
      }
      if (baseCanonical && viewUom === baseCanonical) {
        // Same as row baseline - keep the server perBase when it is
        // already in-ingredient-unit; otherwise null.
        return {
          ...li,
          viewPrice: li.perBaseUom === row.baseUom ? li.perBase : null,
        };
      }
      const result = priceInUnit(
        {
          perBase: li.perBase,
          baseUom: li.perBaseUom,
          packQty: li.packQty ?? null,
          packSize: li.packSize ?? null,
          packUom: li.packUom ?? null,
          caseWeightLb: li.caseWeightLb ?? null,
        },
        viewUom,
        { measures: row.measures as Measure[] },
      );
      return { ...li, viewPrice: result?.per ?? null };
    });
  }, [row.linkedItems, row.baseUom, row.measures, viewUom, baseCanonical]);

  // Strip tile reprices from the in-view prices (same math as the row
  // baseline but through viewUom). When viewUom === baseCanonical the
  // server's active.avgPerBase stays authoritative.
  const stripPrice: number | null = useMemo(() => {
    if (baseCanonical && viewUom === baseCanonical) return active.avgPerBase;
    const priced = repricedLinkedItems
      .filter((li) => li.statusKind === "in_blend" && li.viewPrice != null)
      .map((li) => ({ p: li.viewPrice as number, w: li.usd12m }));
    if (priced.length === 0) return null;
    const totW = priced.reduce((a, b) => a + b.w, 0);
    if (totW <= 0) {
      return priced.reduce((a, b) => a + b.p, 0) / priced.length;
    }
    return priced.reduce((a, b) => a + b.p * b.w, 0) / totW;
  }, [repricedLinkedItems, active.avgPerBase, baseCanonical, viewUom]);

  // Polish fix 3: min/max for the Spread tile reprices alongside the
  // selected unit. Same filter as the strip price - in-blend items
  // with a viewPrice.
  const stripMinMax: { min: number; max: number } | null = useMemo(() => {
    if (baseCanonical && viewUom === baseCanonical) {
      return active.minPerBase != null && active.maxPerBase != null
        ? { min: active.minPerBase, max: active.maxPerBase }
        : null;
    }
    const priced = repricedLinkedItems
      .filter((li) => li.statusKind === "in_blend" && li.viewPrice != null)
      .map((li) => li.viewPrice as number);
    if (priced.length === 0) return null;
    return { min: Math.min(...priced), max: Math.max(...priced) };
  }, [
    repricedLinkedItems,
    active.minPerBase,
    active.maxPerBase,
    baseCanonical,
    viewUom,
  ]);

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

      {/* M2 §4B part 3 fix 9: chip view switch. Picks which unit
          every row in the expand is priced in. Browser-only reprice
          via priceInUnit; status (in blend / needs measure / etc.)
          is unchanged. Resets when the expand remounts (per row.id). */}
      {reachList.length > 1 ? (
        <div className="kf-ingp__dzone-chips" aria-label="Show prices in">
          {reachList.map((u) => {
            const isActive = u === viewUom;
            return (
              <button
                key={u}
                type="button"
                className={`kf-chip${isActive ? " kf-chip--solid" : " kf-chip--line"}`}
                onClick={() => setViewUom(u)}
                aria-pressed={isActive}
              >
                {/* Polish fix 3: chip label is the plain unit ("lb"),
                    not "per lb" - the strip's "/ lb" already supplies
                    the preposition. */}
                {uomLabel(u)}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Strip - round 2 fix 9: value + unit on one line, no wrap;
          lens select below Price is the compact chrome, never
          clipped, with a 44 px click target. */}
      <div className="kf-ipanel__strip kf-ingp__dzone-strip">
        <div className="kf-ipanel__strip-cell">
          <span className="kf-ipanel__strip-label">
            {effectiveLens === "blended" ? "Price" : effectiveLens === "standard" ? "Standard price" : "Premium price"}
          </span>
          <span className="kf-ipanel__strip-value kf-ipanel__strip-value--accent">
            {stripPrice != null ? fmtUsd(stripPrice) : "-"}{" "}
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
            {stripMinMax
              ? `${fmtUsd(stripMinMax.min)} to ${fmtUsd(stripMinMax.max)}`
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
          suggestionCandidates={row.linkedItems
            .filter((li) => li.packQty != null && li.packSize != null && li.packUom != null)
            .map((li) => ({
              id: li.id,
              packQty: li.packQty ?? null,
              packSize: li.packSize ?? null,
              packUom: li.packUom ?? null,
              usd12m: li.usd12m,
            }))}
          itemsReachBase={row.linkedItems.every((li) => li.statusKind !== "needs_measure")}
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
          <LinkedItems
            row={row}
            onOpenItem={onOpenItem}
            viewUom={viewUom}
            viewUnitLabel={uom}
            repricedItems={repricedLinkedItems}
          />
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
  if (row.issues.includes("sizes_differ")) {
    // M2.1 fix 2: sizes_differ had no explanation block. The lead
    // counts the items the pipeline tagged; the body mirrors the
    // detail panel's attention banner so both surfaces say the same
    // sentence.
    const n = row.linkedItems.filter((li) => li.statusKind === "sizes_differ").length;
    issues.push({
      lead: `${fmtCount(n)} case${n === 1 ? "" : "s"} come in different sizes.`,
      body: (
        <>
          {" "}This ingredient is costed per <strong>{uom}</strong>, but its cases hold different
          piece sizes within one kind. Say what one each is, or cost this ingredient by weight or
          volume - whichever kind the cases are in.
        </>
      ),
    });
  }
  if (row.issues.includes("needs_measure")) {
    const n = row.linkedItems.filter((li) => li.statusKind === "needs_measure").length;
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
    k === "spread" || k === "outlier" ? 3 : k === "needs_measure" ? 2 : 1;
  const strongestKind = [...row.issues].sort((a, b) => toneRank(b) - toneRank(a))[0];
  const tone =
    strongestKind === "spread" || strongestKind === "outlier" ? "bad" : strongestKind === "needs_measure" ? "info" : "warn";

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
  viewUom,
  viewUnitLabel,
  repricedItems,
}: {
  row: MasterRow;
  onOpenItem: (id: string) => void;
  viewUom: string;
  viewUnitLabel: string;
  repricedItems: Array<MasterLinkedItem & { viewPrice: number | null }>;
}) {
  // N12 §R1 echo: lowest / highest tag among items IN THE BLEND
  // (priced in the ingredient's dimension through M2's priceInUnit).
  // Need 2+; ties tag the first; no tag when min === max. Tags run
  // off the repriced view, not the server baseline.
  const tagMap = useMemo(() => {
    const m = new Map<string, "lowest" | "highest">();
    const inBlend = repricedItems.filter(
      (li) => li.statusKind === "in_blend" && li.viewPrice != null
    );
    if (inBlend.length < 2) return m;
    const sorted = [...inBlend].sort(
      (a, b) => (a.viewPrice ?? 0) - (b.viewPrice ?? 0)
    );
    const min = sorted[0].viewPrice;
    const max = sorted[sorted.length - 1].viewPrice;
    if (min === max) return m;
    m.set(sorted[0].id, "lowest");
    m.set(sorted[sorted.length - 1].id, "highest");
    return m;
  }, [repricedItems]);

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
        {repricedItems.map((li) => {
          const tag = tagMap.get(li.id);
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
                  {/* T3 §4: every row left out of the blend names why
                      on the same sub-line, in the same style. Before
                      this fix only needs_measure and outlier rows got
                      a reason - sizes_differ rows read "0 of 6 priced
                      - / each" above six rows showing prices with no
                      explanation. */}
                  {li.statusKind === "sizes_differ" ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        left out - pack sizes differ
                      </span>
                    </>
                  ) : null}
                  {li.statusKind === "needs_measure" ? (
                    <>
                      {" · "}
                      <span className="kf-ingp__item-sub-warn">
                        priced per {uomLabel(li.perBaseUom) || "?"}, not per {base}
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
                    {li.viewPrice != null ? (
                      <>
                        <b>{fmtUsd(li.viewPrice)}</b> / {viewUnitLabel}
                      </>
                    ) : (
                      <b>- / {viewUnitLabel}</b>
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
