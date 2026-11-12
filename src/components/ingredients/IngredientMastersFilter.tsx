"use client";

// Client-side search / sort / filter over the already-loaded master
// list from IngredientMasters. Mirrors ReviewFilter's shape: sticky
// search + chip rail. Workbench shape: list on the left, persistent
// detail pane on the right (Prompt Q1), with each linked vendor item
// in the pane carrying an "Open" link to the vendor-items drawer so
// Kevin can jump to the bad one.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowLeft,
  Check,
  DollarSign,
  Flame,
  Info,
  Scale,
  Search,
  Tag,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { ItemPanelById } from "./ItemPanelById";
import { IngredientPanelById } from "./IngredientPanelById";
import { IngredientAllergens } from "./IngredientAllergens";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { BaseUnitControl } from "./panel/BaseUnitControl";
import {
  WEIGHT_UOMS,
  VOLUME_UOMS,
  uomLabel,
  DIM_BY_UOM,
} from "@/lib/ingredients/pack";
import { deriveRecipePrice } from "@/lib/ingredients/eachMeasure";
import { RowSendBackButton } from "./RowSendBackButton";
import { RowGradeToggle } from "./RowGradeToggle";
import { MasterSendAllBackButton } from "./MasterSendAllBackButton";

// The four problems the bad-pack radar actually finds. They have
// different fixes, so they are reported separately rather than as one
// "flagged" boolean. "band" is the pre-existing absolute-range check.
// B4: "empty" - no live vendor items under this master. Usually
// means "ready to retire"; sits in the attention set because the
// master cannot be costed at all and is more actionable than any
// other flag.
export type MasterIssue = "spread" | "coverage" | "mismatch" | "outlier" | "band" | "empty";

// G2: full stats tile set for one lens (blended / standard / premium).
// Every detail-pane tile (price, spread, in-this-price, 12-mo spend)
// reads from one of these per lens choice, so switching lens swaps
// the entire row. See IngredientMasters.tsx buildLensStats for the
// per-subset math - outlier exclusion is per-subset, mean is
// spend-weighted, min/max/spread stay unweighted.
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
  // true when the stored price_estimate.base_uom couldn't be
  // converted to the master's base_unit (different dimension; e.g.
  // the pack parse wrote $/LB but the master is 'each').
  unitMismatch: boolean;
  // S3: true when this item was EXCLUDED from the master's blend
  // because it sits >3x median or <median/3 across the priced items in
  // the master's dimension. Only possible with 3+ priced in-dim items;
  // below that there's no median to be an outlier against. Never set
  // on a unit-mismatched item - its number is in a different dimension
  // and would not be comparable. Computed server-side so the client
  // and the master-level flag cannot drift apart.
  outlier: boolean;
  // S3: hand-set price survives the backfill and is still subject to
  // the outlier rule. Surfaced on the chip as "set by hand" so the
  // user sees the fix is the override, not the parser.
  priceManualOverride: boolean;
  // G1: stored grade on the item. Null is standard; 'premium' is the
  // only sanctioned non-null value today.
  grade: string | null;
  usd12m: number;
  // N6: per-item each measure override. Linked-item lines read this
  // through deriveRecipePrice so an override shows the item's own
  // derived price next to its per-each.
  eachMeasure: { qty: number; uom: string } | null;
};

export type MasterRow = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  baseUnit: string;
  resale: boolean;
  // B1 (allergens): three-state model via allergensReviewedAt. Null
  // means unreviewed - the row renders the "Check allergens" marker
  // and the master contributes to the Unreviewed chip's count.
  // See src/lib/ingredients/allergens.ts for the full state table.
  allergens: string[];
  allergensReviewedBy: string | null;
  allergensReviewedAt: string | null;
  linkedCount: number;
  usd12m: number;
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
  // G2: full per-lens stats. All four detail-pane tiles (price,
  // spread, in-this-price, 12-mo spend) follow the lens. The flat
  // avgPerBase/etc. above stay as the blended values for the list
  // row's own readers. See LensStats + statsByLens construction in
  // IngredientMasters.tsx for the exact per-subset math.
  statsByLens: {
    blended: LensStats;
    standard: LensStats;
    premium: LensStats;
  };
  baseUom: string | null;
  flagged: boolean;
  flagReason: string | null;
  // How many of linkedCount actually contributed a per-base value to
  // the blend above. pricedCount < linkedCount means avgPerBase
  // describes a subset, and unpricedUsd is the 12-month spend sitting
  // outside it.
  pricedCount: number;
  unpricedUsd: number;
  issues: MasterIssue[];
  // The base_unit this master's own priced items agree on, when that
  // disagrees with the master's current one. Null when they agree or
  // the vote is inconclusive. A suggestion only - see Prompt R1.
  suggestedBaseUnit: string | null;
  // S3: median of the priced-in-dim items BEFORE outlier exclusion.
  // The attention note reads this to say what the excluded items
  // deviated from. Null when no priced items in-dim.
  medianBeforeExclusion: number | null;
  linkedItems: MasterLinkedItem[];
  // N6: the master's own each measure + source. Only meaningful on
  // each-costed masters; null everywhere else. The row's derived price
  // is avgPerBase through deriveRecipePrice with itemMeasure = null -
  // the ingredient's measure only; item overrides live on the linked
  // item lines, not the row header.
  eachMeasureQty: number | null;
  eachMeasureUom: string | null;
  eachMeasureSource: string | null;
};

type SortMode = "spend" | "name" | "links" | "spread";

// Badge wording. Short enough to sit inline on the row's sub-line, and
// each one names the fix: "Coverage" means links are missing a price,
// "Unit" means a dimension mismatch, not a wrong number.
const ISSUE_LABEL: Record<string, string> = {
  spread: "Spread",
  coverage: "Coverage",
  mismatch: "Unit",
  outlier: "Outlier",
  band: "Out of band",
  empty: "No vendor items",
};

// N6: local uomLabel is deleted in favour of the shared one imported
// from pack.ts above. Call sites pass empty string through uomLabel
// which returns "" rather than "unit"; add the unit fallback here.
function uomOrUnit(uom: string | null): string {
  return uom ? uomLabel(uom) : "unit";
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

// R2: the workbench is used by two tabs. The server pre-filters rows
// by resale flag before passing them in, so this component does not
// need to split by resale itself - the Recipe only / Resale only
// chips are retired here. mode is carried through so the search
// placeholder names the right subset.
export function IngredientMastersFilter({
  rows,
  mode = "recipe",
}: {
  rows: MasterRow[];
  mode?: "recipe" | "resale";
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("spend");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  // B1 (allergens): "Unreviewed" chip. Kept separate from onlyFlagged
  // on purpose - Needs-attention is the spread/unit/outlier signal
  // (small, actionable); allergen-unreviewed is a to-do backlog
  // (initially matches every master). Collapsing them would wreck
  // the Needs-attention signal.
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  // B4 (empty master): dedicated chip for masters with no live
  // vendor items. The "empty" tag also sits inside r.issues, so
  // onlyFlagged catches these; this chip narrows directly to the
  // retire-candidate set.
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // Workbench selection. `selId` is the user's explicit pick; the row
  // actually shown falls back to the first row in the current filter, so
  // the pane is never empty while the list has contents and a filter that
  // excludes the selection does not strand the pane on a hidden master.
  // Derived, not an effect - no render loop, no stale selection.
  const [selId, setSelId] = useState<string | null>(null);
  // On narrow viewports the index and the pane occupy the same space;
  // this says which one the user is looking at.
  const [paneOpen, setPaneOpen] = useState(false);
  // Item-panel opened from a linked-items row (Prompt A1). One
  // <ItemPanelById> is mounted at the island level and switches on
  // this id, so the panel is never duplicated per row.
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  // Ingredient-editor panel opened from a master name (Prompt A4).
  // The same shared DetailPanel in its ingredient-mode, fed by
  // /api/review/ingredient. One <IngredientPanelById> at the island
  // root; the id drives the fetch.
  const [openIngredientId, setOpenIngredientId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the input; Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        e.preventDefault();
        setQuery("");
        inputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const perSuperCount = useMemo(() => {
    const m = new Map<string, number>();
    m.set("all", rows.length);
    for (const c of SUPER_CATEGORIES) m.set(c, 0);
    for (const r of rows) {
      if (r.category && m.has(r.category)) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    let out = rows;
    if (trimmed) out = out.filter((r) => matches(r, trimmed));
    if (superCat !== "all") out = out.filter((r) => r.category === superCat);
    // R2: resaleFilter removed - the server already pre-split rows
    // by pr_ingredients.resale, so recipe/resale toggles here would
    // only ever match "all" of this tab's set.
    if (onlyFlagged) out = out.filter((r) => r.issues.length > 0);
    if (onlyUnreviewed) out = out.filter((r) => r.allergensReviewedAt == null);
    if (onlyEmpty) out = out.filter((r) => r.issues.includes("empty"));
    if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "links") out = [...out].sort((a, b) => b.linkedCount - a.linkedCount);
    else if (sort === "spread") {
      out = [...out].sort((a, b) => (b.spreadRatio ?? 0) - (a.spreadRatio ?? 0));
    } else {
      out = [...out].sort((a, b) => b.usd12m - a.usd12m);
    }
    return out;
  }, [rows, trimmed, superCat, onlyFlagged, onlyUnreviewed, onlyEmpty, sort]);

  // The row the pane shows. Explicit pick when there is one, else the
  // first row of the current filter - so the pane is never empty while
  // the list has contents, and a filter that hides the selection cannot
  // strand the pane on an invisible master. Derived, not an effect.
  const selected = useMemo(
    () => filtered.find((r) => r.id === selId) ?? filtered[0] ?? null,
    [filtered, selId]
  );
  const matchedUsd = useMemo(
    () => filtered.reduce((s, r) => s + r.usd12m, 0),
    [filtered]
  );
  const matchedFlagged = useMemo(
    () => filtered.filter((r) => r.issues.length > 0).length,
    [filtered]
  );
  // Whole-set count for the chip, so the chip and the "Needs attention"
  // tile above it can never disagree.
  const needsCount = useMemo(
    () => rows.filter((r) => r.issues.length > 0).length,
    [rows]
  );
  // B1 (allergens): whole-set count of masters that have never been
  // reviewed. Starts equal to rows.length - every master is unreviewed
  // today - and decays as a human confirms them.
  const unreviewedCount = useMemo(
    () => rows.filter((r) => r.allergensReviewedAt == null).length,
    [rows]
  );
  // B4: whole-set count of empty masters (zero live vendor items).
  const emptyCount = useMemo(
    () => rows.filter((r) => r.issues.includes("empty")).length,
    [rows]
  );
  const anyFilterActive =
    trimmed.length > 0 ||
    superCat !== "all" ||
    onlyFlagged ||
    onlyUnreviewed ||
    onlyEmpty;

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setOnlyFlagged(false);
    setOnlyUnreviewed(false);
    setOnlyEmpty(false);
    inputRef.current?.focus();
  }

  return (
    <>
      <div className="kf-review__search">
        <form
          className="kf-field kf-field--search kf-review__search-field"
          onSubmit={(e) => e.preventDefault()}
          role="search"
          aria-label="Filter masters"
        >
          <span className="kf-field__icon" aria-hidden>
            <Search size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={inputRef}
            type="search"
            placeholder={
              mode === "resale"
                ? "Filter retail by name, linked vendor or SKU"
                : "Filter by name, parent, category, linked vendor or SKU"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter masters"
          />
          {trimmed.length > 0 ? (
            <button
              type="button"
              className="kf-field__clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear filter"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          ) : (
            <kbd className="kf-field__kbd" aria-hidden>/</kbd>
          )}
        </form>
        <span className="kf-review__search-count" aria-live="polite">
          {!anyFilterActive ? (
            <>
              <strong>{fmtCount(rows.length)}</strong> masters &middot;{" "}
              <strong>{fmtUsd(matchedUsd)}</strong>
            </>
          ) : (
            <>
              <strong>{fmtCount(filtered.length)}</strong> of {fmtCount(rows.length)}{" "}
              masters &middot; <strong>{fmtUsd(matchedUsd)}</strong>
              {matchedFlagged > 0 ? (
                <>
                  {" "}&middot; <strong>{fmtCount(matchedFlagged)}</strong> need attention
                </>
              ) : null}
            </>
          )}
        </span>
      </div>

      {/* Polish 4 (D): same "Sort" kicker Polish 3 gave the Review
          queue, so a filled sort chip (Spend / A-Z / ...) does not
          read as another selected filter next to the category chips. */}
      <div className="kf-review__toolbar" role="toolbar" aria-label="Sort and filter">
        <span className="kf-review__kicker" aria-hidden>Sort</span>
        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Sort order">
          <button
            type="button"
            role="radio"
            aria-checked={sort === "spend"}
            aria-pressed={sort === "spend"}
            className={`kf-chip${sort === "spend" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("spend")}
            title="Highest annual spend first"
          >
            <DollarSign size={14} strokeWidth={1.5} aria-hidden />
            <span>Spend</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "name"}
            aria-pressed={sort === "name"}
            className={`kf-chip${sort === "name" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("name")}
          >
            <ArrowDownAZ size={14} strokeWidth={1.5} aria-hidden />
            <span>A-Z</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "links"}
            aria-pressed={sort === "links"}
            className={`kf-chip${sort === "links" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("links")}
            title="Most linked vendor items first"
          >
            <ArrowDownWideNarrow size={14} strokeWidth={1.5} aria-hidden />
            <span>Links</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "spread"}
            aria-pressed={sort === "spread"}
            className={`kf-chip${sort === "spread" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("spread")}
            title="Widest price spread first (bad-pack radar)"
          >
            <Flame size={14} strokeWidth={1.5} aria-hidden />
            <span>Spread</span>
          </button>
        </div>

        <span className="kf-chips__sep" aria-hidden />

        <div className="kf-review__toolbar-group kf-review__cats" role="radiogroup" aria-label="Category filter">
          <button
            type="button"
            role="radio"
            aria-checked={superCat === "all"}
            aria-pressed={superCat === "all"}
            className={`kf-chip${superCat === "all" ? " kf-chip--on" : ""}`}
            onClick={() => setSuperCat("all")}
          >
            All <span className="kf-chip__count">{fmtCount(perSuperCount.get("all") ?? 0)}</span>
          </button>
          {SUPER_CATEGORIES.map((c) => {
            const n = perSuperCount.get(c) ?? 0;
            // Polish 4: hide zero-count categories here too (matches
            // the Polish 3 treatment in ReviewFilter). Reappear on
            // the next render when a master lands under them.
            if (n === 0) return null;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={superCat === c}
                aria-pressed={superCat === c}
                className={`kf-chip${superCat === c ? " kf-chip--on" : ""}`}
                onClick={() => setSuperCat(c)}
              >
                {c} <span className="kf-chip__count">{fmtCount(n)}</span>
              </button>
            );
          })}
        </div>

        {/* R2: Recipe only / Resale only chips removed - the server
            pre-filters this list by resale, so each tab shows one
            homogeneous subset and the toggles would be no-ops. The
            Needs-attention chip stays in both modes; a resale master
            with a spread or unit mismatch is still worth surfacing. */}
        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Attention filter">
          <button
            type="button"
            role="radio"
            aria-checked={onlyFlagged}
            aria-pressed={onlyFlagged}
            className={`kf-chip kf-chip--warn${onlyFlagged ? " kf-chip--on" : ""}`}
            onClick={() => setOnlyFlagged((v) => !v)}
            title="Masters with a spread, coverage, unit or outlier issue"
          >
            Needs attention <span className="kf-chip__count">{fmtCount(needsCount)}</span>
          </button>
          {/* B1: Unreviewed allergens filter. Kept beside Needs
              attention (both are quiet to-do markers) but on its own
              chip - allergen-unreviewed and spread-outlier are
              different signals. */}
          <button
            type="button"
            role="radio"
            aria-checked={onlyUnreviewed}
            aria-pressed={onlyUnreviewed}
            className={`kf-chip kf-chip--warn${onlyUnreviewed ? " kf-chip--on" : ""}`}
            onClick={() => setOnlyUnreviewed((v) => !v)}
            title="Masters whose Top 9 allergens have not been reviewed"
          >
            Check allergens <span className="kf-chip__count">{fmtCount(unreviewedCount)}</span>
          </button>
          {/* B4: narrow the list to empty masters (no live vendor
              items). Quiet warn chip like the others; the count is
              live. These masters also contribute to Needs attention
              through the shared r.issues array. */}
          <button
            type="button"
            role="radio"
            aria-checked={onlyEmpty}
            aria-pressed={onlyEmpty}
            className={`kf-chip kf-chip--warn${onlyEmpty ? " kf-chip--on" : ""}`}
            onClick={() => setOnlyEmpty((v) => !v)}
            title="Masters with no live vendor items (candidates to retire)"
          >
            No vendor items <span className="kf-chip__count">{fmtCount(emptyCount)}</span>
          </button>
          {anyFilterActive ? (
            <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm" onClick={clearAll}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* Polish 7: the flags legend moves OUT of the card so the card
          opens with its shaded column-header band. The legend here is
          a quiet single line below the sort/filter row, above the
          workbench. Variant modifier kf-table-legend--quiet drops the
          band fill + top-bottom border so it reads as a horizontal
          strip, not a header band. */}
      {filtered.length > 0 ? (
        <div className="kf-table-legend kf-table-legend--quiet" aria-label="Attention legend">
          <span className="kf-table-legend__label">Flags</span>
          <span className="kf-master__bdg kf-master__bdg--spread">Spread</span>
          <span className="kf-table-legend__hint">over 3x</span>
          <span className="kf-master__bdg kf-master__bdg--coverage">Coverage</span>
          <span className="kf-table-legend__hint">missing a price</span>
          <span className="kf-master__bdg kf-master__bdg--mismatch">Unit</span>
          <span className="kf-table-legend__hint">another dimension</span>
          <span className="kf-master__bdg kf-master__bdg--outlier">Outlier</span>
          <span className="kf-table-legend__hint">far from the blend</span>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="kf-empty">
          <div>
            <div className="kf-empty__title">No masters match the current filters</div>
            <div className="kf-empty__body">
              Try clearing filters, or widen the category.
            </div>
          </div>
          <button type="button" className="kf-btn kf-btn--soft kf-btn--sm" onClick={clearAll}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className={`kf-wb${paneOpen ? " kf-wb--pane" : ""}`}>
          <div className="kf-wb__index">
            {/* Polish 7: shaded header band - mirrors vendor-items thead
                (background var(--sp-sky-soft), hairline border-bottom)
                so the card opens with the same column-label treatment
                every table in the section uses. */}
            <div className="kf-masters__head" aria-hidden>
              <span>Ingredient</span>
              <span className="kf-masters__head-num">Per-unit</span>
              <span className="kf-masters__head-num">12-mo</span>
            </div>
            <ul className="kf-masters__list" aria-label="Masters">
              {filtered.map((row) => (
                <li key={row.id}>
                  <MasterRowButton
                    row={row}
                    selected={selected?.id === row.id}
                    onSelect={() => {
                      setSelId(row.id);
                      setPaneOpen(true);
                    }}
                    onOpen={() => setOpenIngredientId(row.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
          <div className="kf-wb__detail">
            {selected ? (
              <MasterDetail
                row={selected}
                onBack={() => setPaneOpen(false)}
                onOpenItem={(id) => setOpenItemId(id)}
              />
            ) : null}
          </div>
        </div>
      )}
      {/* One mount, keyed by the open id so the fetch effect reruns on
          change. Not mounted per-row - a master with 10 linked items
          still has exactly one <ItemPanelById>. */}
      <ItemPanelById itemId={openItemId} onClose={() => setOpenItemId(null)} />
      {/* Same shape for the ingredient editor (A4). The master name is
          a button that sets openIngredientId; this one mount drives the
          panel for the whole pane. */}
      <IngredientPanelById
        ingredientId={openIngredientId}
        onClose={() => setOpenIngredientId(null)}
      />
    </>
  );
}

function MasterRowButton({
  row,
  selected,
  onSelect,
  onOpen,
}: {
  row: MasterRow;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const uom = uomOrUnit(row.baseUom);
  const lv = row.spreadRatio == null ? null : row.spreadRatio > 3 ? "hi" : row.spreadRatio > 2 ? "mid" : "ok";
  // A4 nests a real <button> for the master name inside the row.
  // HTML forbids button-in-button, so the row swaps to a role="button"
  // div. Keyboard reach stays the same (tabIndex 0 + Enter/Space),
  // and the pane-selection click handler is undisturbed; the name
  // button stops propagation so clicking the name opens the editor
  // without also selecting the row.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-current={selected ? "true" : undefined}
      className={`kf-master__row${row.issues.length > 0 ? " kf-master__row--flagged" : ""}`}
    >
      <span className="kf-master__name-col">
        <button
          type="button"
          className="kf-master__name kf-master__nameopen"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onKeyDown={(e) => {
            // Space on a button toggles; stop it from bubbling to the
            // row's Space-activates handler so one keystroke does one
            // thing. Enter still bubbles, which keeps the native
            // button activation route intact for AT.
            if (e.key === " ") e.stopPropagation();
          }}
          title={`Open ingredient editor for ${row.name}`}
        >
          {row.name}
        </button>
        <span className="kf-master__sub">
          {row.category ? row.category : <em className="kf-muted">Needs category</em>}
          {row.parent ? <> &middot; {row.parent}</> : null}
          {row.resale ? <> &middot; <span className="kf-pill kf-pill--muted">Retail</span></> : null}
          {row.spreadRatio != null ? (
            <span className="kf-master__spr" title={`${fmtUsd(row.minPerBase ?? 0)} to ${fmtUsd(row.maxPerBase ?? 0)} per ${uom}`}>
              <span className="kf-master__spr-track">
                <span
                  className="kf-master__spr-fill"
                  data-lv={lv ?? undefined}
                  style={{
                    width: `${Math.max(
                      Math.min(Math.log(row.spreadRatio) / Math.log(20), 1) * 100,
                      6
                    )}%`,
                  }}
                />
              </span>
              <span className={`kf-master__spr-n${row.spreadRatio > 3 ? " kf-master__spr-n--hi" : ""}`}>
                {row.spreadRatio.toFixed(1)}x
              </span>
            </span>
          ) : null}
          {row.issues.map((k) => (
            <span key={k} className={`kf-master__bdg kf-master__bdg--${k}`}>
              {ISSUE_LABEL[k] ?? k}
            </span>
          ))}
          {/* B1: a to-do marker, not an error - uses the same muted
              register as the issue badges but a distinct variant so
              Needs-attention and Unreviewed never read as one signal. */}
          {row.allergensReviewedAt == null ? (
            <span
              className="kf-master__bdg kf-master__bdg--unreviewed"
              title="Allergens not yet reviewed"
            >
              Check allergens
            </span>
          ) : null}
        </span>
      </span>

      <span className="kf-master__price-col">
        {row.avgPerBase != null ? (
          <span>
            <strong>{fmtUsd(row.avgPerBase)}</strong>
            <span className="kf-muted"> / {uom}</span>
            {(() => {
              // N6: derived recipe price on each-costed rows. Reads the
              // ingredient's own measure only - per-item overrides
              // appear on the linked-item lines, not the row header
              // (go-message adjustment 2). baseUom === "EA" means the
              // master is per-each; the helper returns null when there
              // is no measure.
              const ingMeasure =
                row.eachMeasureQty != null && row.eachMeasureUom
                  ? { qty: row.eachMeasureQty, uom: row.eachMeasureUom }
                  : null;
              const derived = deriveRecipePrice({
                perBase: row.avgPerBase,
                perBaseUom: row.baseUom,
                itemMeasure: null,
                ingredientMeasure: ingMeasure,
              });
              if (!derived) return null;
              return (
                <>
                  <span className="kf-muted"> · </span>
                  <strong>{fmtUsd(derived.per)}</strong>
                  <span className="kf-muted"> / {uomLabel(derived.uom)}</span>
                </>
              );
            })()}
          </span>
        ) : (
          <span className="kf-muted">- / {row.baseUnit?.toLowerCase() ?? "unit"}</span>
        )}
        {row.linkedCount > 0 ? (
          <span
            className={`kf-master__cov${
              row.pricedCount < row.linkedCount ? " kf-master__cov--part" : ""
            }`}
          >
            <span className="kf-master__cov-track">
              <span
                className="kf-master__cov-fill"
                style={{ width: `${Math.round((row.pricedCount / row.linkedCount) * 100)}%` }}
              />
            </span>
            {fmtCount(row.pricedCount)} of {fmtCount(row.linkedCount)} priced
          </span>
        ) : null}
      </span>

      <span className="kf-master__spend-col">{fmtUsd(row.usd12m)}</span>
    </div>
  );
}

// The schema's CHECK constraint, in the order a chef would scan them.
// `dozen` is in the constraint and on exactly one master today; it stays
// available but last.
// N6: dropdown options come from the shared vocabulary. Weight and
// volume groups are offered as <optgroup>s; count stays last.
const BASE_UNIT_GROUPS: { label: string; options: string[] }[] = [
  { label: "Weight", options: WEIGHT_UOMS.map((u) => u.toLowerCase()) },
  { label: "Volume", options: VOLUME_UOMS.map((u) => u.toLowerCase()) },
  { label: "Count",  options: ["each", "dozen"] },
];

// N6: display word for the "Cost this per X" copy. Delegates to the
// shared uomLabel; pluralises when the row's unit maps to a mass noun
// (lb, kg) rather than a single-form noun (each, oz is both).
const BASE_UNIT_WORD: Record<string, string> = {
  lb: "pounds",
  oz: "ounces",
  g: "grams",
  kg: "kilograms",
  floz: "fluid ounces",
  pt: "pints",
  qt: "quarts",
  gal: "gallons",
  l: "liters",
  ml: "milliliters",
  each: "each",
  dozen: "dozens",
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

function errText(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

// N7 B6: BaseUnitControl moved to ./panel/BaseUnitControl.tsx so the
// item panel's ingredient zone can mount the same writer. Markup and
// behaviour unchanged.

// N11 §2: usual measure of one each. Explicit Save button; the prior
// blur-commit and unit-change auto-save are gone. On a stored
// measure, emptying the number is the Remove-measure draft (R3) and
// Save reads "Remove measure"; on an empty row, the editor starts
// with no unit (disabled "Unit" placeholder per R1) and Save is
// disabled until a number and unit are picked. Source lives on the
// detail panel and is not part of this draft (R5).
function EachMeasureControl({ row }: { row: MasterRow }) {
  const router = useRouter();
  type Shape = { qty: string; uom: string };
  const makeBaseline = (): Shape => ({
    qty: row.eachMeasureQty == null ? "" : String(row.eachMeasureQty),
    uom: (row.eachMeasureUom ?? "").toUpperCase(),
  });
  const equalShape = (a: Shape, b: Shape) => a.qty === b.qty && a.uom === b.uom;

  const [baseline, setBaseline] = useState<Shape>(() => makeBaseline());
  const [draft, setDraft] = useState<Shape>(baseline);
  const [busy, setBusy] = useState(false);
  const prevId = useRef(row.id);
  const priorStoredRef = useRef<Shape>(baseline);

  useEffect(() => {
    const next: Shape = {
      qty: row.eachMeasureQty == null ? "" : String(row.eachMeasureQty),
      uom: (row.eachMeasureUom ?? "").toUpperCase(),
    };
    const idChanged = prevId.current !== row.id;
    const priorStored = priorStoredRef.current;
    prevId.current = row.id;
    priorStoredRef.current = next;
    setBaseline(next);
    setDraft((cur) => (idChanged || equalShape(cur, priorStored) ? next : cur));
  }, [row.id, row.eachMeasureQty, row.eachMeasureUom]);

  const dirty = !equalShape(draft, baseline);
  const qtyTrimmed = draft.qty.trim();
  const qtyNum = Number(qtyTrimmed);
  const qtyValid = qtyTrimmed !== "" && Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= 100000;
  const uomDim = DIM_BY_UOM[draft.uom];
  const uomValid = uomDim === "weight" || uomDim === "volume";

  const removing = dirty && qtyTrimmed === "" && row.eachMeasureQty != null;
  const writing = dirty && qtyValid && uomValid;
  const saveEnabled = !busy && (removing || writing);

  const hint =
    qtyTrimmed === "" && row.eachMeasureQty == null ? "Enter a number"
    : qtyValid && !uomValid ? "Pick a unit"
    : null;

  async function doSave() {
    if (!saveEnabled) return;
    setBusy(true);
    if (removing) {
      const r = await postJson("/api/review/set-each-measure", {
        ingredientId: row.id,
        qty: null,
      });
      if (!r.ok) {
        toast(errText(r.data, `Clear failed (${r.status})`), { tone: "block" });
        setBusy(false);
        return;
      }
      toast(`${row.name}: measure cleared`);
      const cleared: Shape = { qty: "", uom: "" };
      priorStoredRef.current = cleared;
      setBaseline(cleared);
      setDraft(cleared);
      setBusy(false);
      router.refresh();
      return;
    }
    const rounded = Math.round(qtyNum * 10000) / 10000;
    const u = draft.uom;
    const r = await postJson("/api/review/set-each-measure", {
      ingredientId: row.id,
      qty: rounded,
      uom: u,
      source: row.eachMeasureSource ?? "house_test",
    });
    if (!r.ok) {
      toast(errText(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`${row.name}: one each is ${rounded} ${uomLabel(u)}`);
    const saved: Shape = { qty: String(rounded), uom: u };
    priorStoredRef.current = saved;
    setBaseline(saved);
    setDraft(saved);
    setBusy(false);
    router.refresh();
  }

  function onDiscard() {
    if (busy) return;
    setDraft(baseline);
  }

  function onKey(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" && saveEnabled) {
      e.preventDefault();
      void doSave();
    } else if (e.key === "Escape" && dirty) {
      e.preventDefault();
      onDiscard();
    }
  }

  const emptyBaseline = row.eachMeasureQty == null && baseline.qty === "";
  const saveLabel = busy ? "Saving..." : removing ? "Remove measure" : "Save";

  return (
    <span className="kf-dt__measure">
      <span className="kf-dt__unitctl">
        <Scale size={13} strokeWidth={1.5} aria-hidden />
        <label className="kf-dt__unitctl-l" htmlFor={`avgw-${row.id}`}>
          One each
        </label>
        <input
          id={`avgw-${row.id}`}
          type="number"
          inputMode="decimal"
          step="0.0001"
          min="0"
          value={draft.qty}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => ({ ...d, qty: v }));
          }}
          onKeyDown={onKey}
          placeholder=""
          aria-label="One each, quantity"
          disabled={busy}
          className="kf-dt__unitsel"
          style={{ width: "6ch" }}
        />
        <select
          value={draft.uom}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            setDraft((d) => ({ ...d, uom: v }));
          }}
          onKeyDown={onKey}
          disabled={busy}
          aria-label="One each, unit"
          className="kf-dt__unitsel"
        >
          <option value="" disabled>Unit</option>
          <optgroup label="Weight">
            {WEIGHT_UOMS.map((u) => (
              <option key={u} value={u}>{uomLabel(u)}</option>
            ))}
          </optgroup>
          <optgroup label="Volume">
            {VOLUME_UOMS.map((u) => (
              <option key={u} value={u}>{uomLabel(u)}</option>
            ))}
          </optgroup>
        </select>
        <button
          type="button"
          className={`kf-btn ${saveEnabled ? "kf-btn--primary" : "kf-btn--line"} kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={!saveEnabled}
          onClick={doSave}
        >
          {saveLabel}
        </button>
        {emptyBaseline && !dirty ? (
          <span className="kf-master__bdg kf-master__bdg--unreviewed">no measure yet</span>
        ) : null}
      </span>
      {dirty ? (
        <span className="kf-dt__measure-note" aria-live="polite">
          {hint ? (
            <span>{hint}</span>
          ) : (
            <>
              <span>Not saved yet</span>
              <span aria-hidden>&middot;</span>
              <button
                type="button"
                className="kf-dt__measure-discard"
                onClick={onDiscard}
                disabled={busy}
              >
                Discard
              </button>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

// The one-click version of the same write, offered inside the mismatch
// note where the evidence for it is sitting.
function SuggestBaseUnitButton({ row }: { row: MasterRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const next = row.suggestedBaseUnit;
  if (!next) return null;

  async function apply() {
    if (busy || !next) return;
    setBusy(true);
    const r = await postJson("/api/review/set-base-unit", {
      ingredientId: row.id,
      baseUnit: next,
    });
    if (!r.ok) {
      toast(errText(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`${row.name} is now costed per ${next}`);
    setBusy(false);
    router.refresh();
  }

  return (
    <button type="button" className="kf-btn kf-btn--sm kf-why__fix" onClick={apply} disabled={busy}>
      <Wand2 size={13} strokeWidth={1.5} aria-hidden />
      {busy ? "Switching…" : `Cost this per ${BASE_UNIT_WORD[next] ?? next} instead`}
    </button>
  );
}

// Typed, plain-English reasons. The whole point of PR52: the badge names
// the problem, this names the fix. Nothing here is hover-only.
function IssueNote({ row }: { row: MasterRow }) {
  const uom = uomOrUnit(row.baseUom);
  const notes: { tone: string; icon: ReactNode; head: string; body: ReactNode }[] = [];

  if (row.issues.includes("spread")) {
    notes.push({
      tone: "bad",
      icon: <Flame size={16} strokeWidth={1.5} aria-hidden />,
      head: `Spread is ${row.spreadRatio?.toFixed(1)}x`,
      body: (
        <>
          Cheapest linked item is {fmtUsd(row.minPerBase ?? 0)}/{uom}, dearest is{" "}
          {fmtUsd(row.maxPerBase ?? 0)}/{uom}. Over 3x usually means one item has a bad pack
          size, not a real price difference.
        </>
      ),
    });
  }
  if (row.issues.includes("coverage")) {
    notes.push({
      tone: "warn",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(row.linkedCount - row.pricedCount)} of ${fmtCount(row.linkedCount)} linked items are not in this price`,
      body: (
        <>
          <strong>{fmtUsd(row.unpricedUsd)}</strong> of this ingredient&rsquo;s{" "}
          {fmtUsd(row.usd12m)} sits outside the blend - either no per-unit price at all, or a
          price in a different unit. The figure above describes {fmtCount(row.pricedCount)}{" "}
          item{row.pricedCount === 1 ? "" : "s"}, not {fmtCount(row.linkedCount)}.
        </>
      ),
    });
  }
  if (row.issues.includes("mismatch")) {
    const n = row.linkedItems.filter((li) => li.unitMismatch).length;
    notes.push({
      tone: "info",
      icon: <Info size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(n)} item${n === 1 ? "" : "s"} priced in a different unit`,
      body: (
        <>
          This master is costed per <strong>{uom}</strong>, but {n === 1 ? "an item is" : "those items are"}{" "}
          priced per a different dimension. Those numbers are not comparable and never reach
          the blend until the unit is fixed.
          {row.suggestedBaseUnit ? (
            <>
              {" "}
              Most of its priced items are in{" "}
              <strong>{BASE_UNIT_WORD[row.suggestedBaseUnit] ?? row.suggestedBaseUnit}</strong>, so
              the ingredient is probably the one set wrong - it was created on the default.
              <SuggestBaseUnitButton row={row} />
            </>
          ) : null}
        </>
      ),
    });
  }
  if (row.issues.includes("outlier")) {
    const o = row.linkedItems.filter((li) => li.outlier);
    const median = row.medianBeforeExclusion;
    notes.push({
      tone: "bad",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: `${fmtCount(o.length)} item${o.length === 1 ? "" : "s"} excluded as outlier${o.length === 1 ? "" : "s"}`,
      body: (
        <>
          {o
            .map(
              (li) =>
                `${li.name} at ${fmtUsd(li.perBase ?? 0)}/${uomLabel(li.perBaseUom)}${li.priceManualOverride ? " (set by hand)" : ""}`
            )
            .join("; ")}
          {median != null ? ` against a ${fmtUsd(median)}/${uom} median.` : "."}{" "}
          Excluded from the master&rsquo;s blend; survivors give{" "}
          {row.avgPerBase != null ? `${fmtUsd(row.avgPerBase)}/${uom}` : "no blend"}.
        </>
      ),
    });
  }
  if (row.issues.includes("band")) {
    notes.push({
      tone: "warn",
      icon: <AlertTriangle size={16} strokeWidth={1.5} aria-hidden />,
      head: "Average is outside the typical band for this unit",
      body: <>A soft signal, not an assertion - worth a look at the pack sizes.</>,
    });
  }

  if (notes.length === 0) {
    return (
      <div className="kf-why kf-why--good">
        <Check size={16} strokeWidth={1.5} aria-hidden />
        <div>
          <b>Nothing flagged</b>
          <span>
            All {fmtCount(row.linkedCount)} linked items carry a price, in one unit, inside the
            expected band.
          </span>
        </div>
      </div>
    );
  }
  return (
    <>
      {notes.map((n) => (
        <div key={n.head} className={`kf-why kf-why--${n.tone}`}>
          {n.icon}
          <div>
            <b>{n.head}</b>
            <span>{n.body}</span>
          </div>
        </div>
      ))}
    </>
  );
}

// G1/G2 (revised 2026-11-04): three-price selector. Default is BLENDED
// so the pane answers the same question as the list row and the recipe
// cost - "what does this cost me". Standard and premium are opt-in
// analysis you reach for when you want to know WHY the blended moved.
// G1 defaulted to Standard because nothing was graded and blended ==
// standard; post-Step B the two diverge and the G1 call becomes a
// list-vs-pane mismatch the user has to explain.
// View state only; not persisted (R-112 pattern).
//
// G2: the lens drives ALL FOUR tiles (price, spread, in-this-price,
// 12-mo spend). Switching to Premium re-scopes the whole row to
// premium-only items. Empty subsets keep the segment clickable but
// dimmed - per Kevin, a dead button would be the common case
// (220/230 masters have no premium items post-Step B).
type PriceLens = "blended" | "standard" | "premium";

const LENS_LABEL: Record<PriceLens, string> = {
  blended: "Blended",
  standard: "Standard",
  premium: "Premium",
};

// G2: eyebrow copy on the price tile. "<Lens> price" so the number
// is unambiguous even if the user scrolled past the lens control.
// BLENDED PRICE / STANDARD PRICE / PREMIUM PRICE (uppercased by
// .kf-dt__stat-l).
const LENS_EYEBROW: Record<PriceLens, string> = {
  blended: "Blended price",
  standard: "Standard price",
  premium: "Premium price",
};

const EMPTY_SUBSET_NOTE: Record<PriceLens, string> = {
  blended: "no priced items",
  standard: "no standard items",
  premium: "no premium items",
};

function MasterDetail({
  row,
  onBack,
  onOpenItem,
}: {
  row: MasterRow;
  onBack: () => void;
  onOpenItem: (itemId: string) => void;
}) {
  const uom = uomOrUnit(row.baseUom);
  const [lens, setLens] = useState<PriceLens>("blended");
  // G3 §3: suppress the lens unless two grades are populated. 10 of
  // 230 masters currently qualify; the other 220 show one grade's
  // price with no view-switch chrome. The control reappears on its
  // own the moment a second grade exists - no flag, no setting.
  const showLens =
    row.statsByLens.standard.linkedCount > 0 && row.statsByLens.premium.linkedCount > 0;
  // When the lens is hidden, read the blended figure (which equals
  // whichever single grade is populated). Pane answers the same
  // question as the list row: "what does this cost".
  const effectiveLens: PriceLens = showLens ? lens : "blended";
  const active = row.statsByLens[effectiveLens];
  const partial = active.pricedCount < active.linkedCount;
  const spreadBad = active.spreadRatio != null && active.spreadRatio > 3;
  return (
    <div className="kf-dt">
      <div className="kf-dt__head">
        <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm kf-dt__back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={1.5} aria-hidden /> All ingredients
        </button>
        <div className="kf-dt__eyebrow">
          {row.category ?? "Needs category"}
          {row.parent ? ` · ${row.parent}` : ""}
        </div>
        <h3 className="kf-dt__title">{row.name}</h3>
        <div className="kf-dt__meta">
          {row.issues.map((k) => (
            <span key={k} className={`kf-master__bdg kf-master__bdg--${k}`}>
              {ISSUE_LABEL[k] ?? k}
            </span>
          ))}
          {row.resale ? <span className="kf-pill kf-pill--muted">Retail</span> : null}
          <BaseUnitControl row={row} />
          {/* N5 frame B: usual weight of one each, right next to the
              base-unit control. Rendered only on each-costed masters;
              dropping to lb / gal / dozen does not clear the stored
              weight, the control just stops showing. */}
          {row.baseUnit === "each" ? <EachMeasureControl row={row} /> : null}
          {/* G3 §1: lens is now a <select> matching BaseUnitControl's
              chrome and register. Native element - keyboard + SR
              behaviour comes free. Hidden entirely when only one
              grade is populated (see showLens above); the segmented
              pill from G1/G2 is retired. */}
          {showLens ? (
            <span className="kf-dt__unitctl">
              <Tag size={13} strokeWidth={1.5} aria-hidden />
              <label className="kf-dt__unitctl-l" htmlFor={`lens-${row.id}`}>
                Price
              </label>
              <select
                id={`lens-${row.id}`}
                className="kf-dt__unitsel"
                value={lens}
                onChange={(e) => setLens(e.target.value as PriceLens)}
              >
                {(["blended", "standard", "premium"] as const).map((k) => (
                  <option key={k} value={k}>{LENS_LABEL[k]}</option>
                ))}
              </select>
            </span>
          ) : null}
        </div>
      </div>

      <div className="kf-dt__stats">
        {/* G2/G3: every tile reads from `active`. With both grades
            populated the lens dropdown swaps subsets. With only one
            grade the lens is hidden and `active` is the blended
            figure (which equals the one grade). Spread and min/max
            stay unweighted - they describe the range of prices, not
            the blended cost. */}
        <div className="kf-dt__stat">
          <span className="kf-dt__stat-l">
            {showLens ? LENS_EYEBROW[lens] : "Price"}
          </span>
          <strong>{active.avgPerBase != null ? fmtUsd(active.avgPerBase) : "-"}</strong>
          <span className="kf-dt__stat-n">
            {active.avgPerBase != null
              ? `per ${uom} · ${fmtCount(active.pricedCount)} priced`
              : EMPTY_SUBSET_NOTE[effectiveLens]}
          </span>
        </div>
        <div className={`kf-dt__stat${spreadBad ? " kf-dt__stat--bad" : ""}`}>
          <span className="kf-dt__stat-l">Spread</span>
          <strong>{active.spreadRatio != null ? `${active.spreadRatio.toFixed(1)}x` : "-"}</strong>
          <span className="kf-dt__stat-n">
            {active.minPerBase != null && active.maxPerBase != null
              ? `${fmtUsd(active.minPerBase)} - ${fmtUsd(active.maxPerBase)}`
              : EMPTY_SUBSET_NOTE[effectiveLens]}
          </span>
        </div>
        <div className={`kf-dt__stat${partial && active.linkedCount > 0 ? " kf-dt__stat--warn" : ""}`}>
          <span className="kf-dt__stat-l">In this price</span>
          <strong>
            {fmtCount(active.pricedCount)} of {fmtCount(active.linkedCount)}
          </strong>
          <span className="kf-dt__stat-n">
            {active.linkedCount === 0
              ? EMPTY_SUBSET_NOTE[effectiveLens]
              : partial
                ? `${fmtUsd(active.unpricedUsd)} outside`
                : "all linked items"}
          </span>
        </div>
        <div className="kf-dt__stat">
          <span className="kf-dt__stat-l">12-mo spend</span>
          <strong>{active.linkedCount > 0 ? fmtUsd(active.usd12m) : "-"}</strong>
          <span className="kf-dt__stat-n">
            {active.linkedCount === 0
              ? EMPTY_SUBSET_NOTE[effectiveLens]
              : `${fmtCount(active.linkedCount)} linked items`}
          </span>
        </div>
      </div>

      <div className="kf-dt__sec">
        <h4 className="kf-dt__sec-h">What needs attention</h4>
        <IssueNote row={row} />
      </div>

      {/* B1 fix: the pill grid lives IN the master detail pane now.
          Previously it was only rendered inside the slide-in
          DetailPanel drawer (opened via the A4 master-name button),
          which left the primary workbench pane with no allergen
          control. The shared IngredientAllergens component drives
          both surfaces. */}
      <div className="kf-dt__sec">
        <h4 className="kf-dt__sec-h">Allergens</h4>
        <IngredientAllergens
          ingredientId={row.id}
          allergens={row.allergens}
          reviewedBy={row.allergensReviewedBy}
          reviewedAt={row.allergensReviewedAt}
        />
      </div>

      {row.linkedCount === 0 ? (
        <div className="kf-dt__sec">
          <div className="kf-empty">
            <div>
              <div className="kf-empty__title">No vendor items</div>
              <div className="kf-empty__body">
                {/* B4: this surface is now reached by two paths - a
                    master just created from a split (waiting for the
                    matcher) and a master that lost all of its items
                    (ready to retire). The copy acknowledges both
                    rather than assuming one. */}
                No live items are linked to this master. If it is a
                fresh split, the matcher will attach items next run;
                otherwise it is likely ready to retire.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="kf-dt__sec">
          <div className="kf-dt__sec-head">
            <h4 className="kf-dt__sec-h">Linked vendor items</h4>
            <MasterSendAllBackButton
              masterName={row.name}
              itemIds={row.linkedItems.map((li) => li.id)}
            />
          </div>
          <table className="kf-master__inner-table">
            <thead>
              <tr>
                <th>Vendor item</th>
                <th>Vendor</th>
                {/* G3 §5: new Grade column. The G1 Premium pill moved
                    out of the Vendor cell and became a per-row toggle
                    here - Standard items now show an affordance too,
                    so there is finally a UI hint that the setting
                    exists. Writes through the G1 path; ledger covers
                    undo. */}
                <th>Grade</th>
                <th className="kf-table__num">Per-unit</th>
                <th className="kf-table__num">Annual $</th>
                {/* G3 §4: Open column retired. The vendor item NAME is
                    already a button that opens ItemPanelById inline;
                    Open was a duplicate route to a different drawer.
                    Send back stays. */}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {row.linkedItems.map((li) => {
                const liUom = uomLabel(li.perBaseUom);
                const outlier = li.outlier;
                return (
                  <tr
                    key={li.id}
                    className={outlier || li.unitMismatch ? "kf-master__inner-row--outlier" : undefined}
                  >
                    <td title={li.name}>
                      <button
                        type="button"
                        className="kf-cell-ellipsis kf-dt__itemopen"
                        onClick={() => onOpenItem(li.id)}
                        title={`Open details for ${li.name}`}
                      >
                        {li.name}
                      </button>
                      {li.unitMismatch ? (
                        <span className="kf-cell-sub kf-cell-sub--note">
                          unit mismatch vs master ({li.perBaseUom ?? "?"})
                        </span>
                      ) : outlier ? (
                        <span className="kf-cell-sub kf-cell-sub--note">
                          outlier · excluded{li.priceManualOverride ? " · set by hand" : ""}
                        </span>
                      ) : null}
                    </td>
                    <td>{li.vendor}</td>
                    <td>
                      <RowGradeToggle itemId={li.id} grade={li.grade} />
                    </td>
                    <td className="kf-table__num">
                      {li.perBase != null ? (
                        <>
                          <strong>{fmtUsd(li.perBase)}</strong>
                          <span className="kf-muted"> / {liUom}</span>
                        </>
                      ) : (
                        <span className="kf-muted">-</span>
                      )}
                    </td>
                    <td className="kf-table__num">{fmtUsd(li.usd12m)}</td>
                    <td className="kf-table__num">
                      <span className="kf-dt__rowacts">
                        <RowSendBackButton itemId={li.id} itemName={li.name} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
