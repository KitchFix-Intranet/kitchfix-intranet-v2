"use client";

// Client-side search / sort / filter over the already-loaded master
// list from IngredientMasters. Mirrors ReviewFilter's shape: sticky
// search + chip rail. Native <details> on each master row for inline
// drill-in (saves a round-trip and keeps Kevin on the page); each
// linked vendor item inside the expand carries an "Open" link to the
// vendor-items drawer so he can jump to the bad one.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ChevronDown, DollarSign, Flame, Search, X } from "lucide-react";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { RowSendBackButton } from "./RowSendBackButton";
import { MasterSendAllBackButton } from "./MasterSendAllBackButton";

// The four problems the bad-pack radar actually finds. They have
// different fixes, so they are reported separately rather than as one
// "flagged" boolean. "band" is the pre-existing absolute-range check.
export type MasterIssue = "spread" | "coverage" | "mismatch" | "outlier" | "band";

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
  // true when this item's converted per-base sits more than 3x above
  // or below the master's blend. Never set on a unit-mismatched item -
  // its number is in a different dimension, so the comparison would be
  // meaningless. Computed server-side so the client and the master-
  // level flag cannot drift apart.
  outlier: boolean;
  usd12m: number;
};

export type MasterRow = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  baseUnit: string;
  resale: boolean;
  linkedCount: number;
  usd12m: number;
  avgPerBase: number | null;
  minPerBase: number | null;
  maxPerBase: number | null;
  spreadRatio: number | null;
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
  linkedItems: MasterLinkedItem[];
};

type SortMode = "spend" | "name" | "links" | "spread";
type ResaleFilter = "all" | "recipe" | "resale";

function uomLabel(uom: string | null): string {
  if (!uom) return "unit";
  if (uom === "LB") return "lb";
  if (uom === "FLOZ") return "fl oz";
  if (uom === "EA") return "each";
  return uom.toLowerCase();
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

export function IngredientMastersFilter({ rows }: { rows: MasterRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("spend");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [resaleFilter, setResaleFilter] = useState<ResaleFilter>("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
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
    if (resaleFilter === "recipe") out = out.filter((r) => !r.resale);
    else if (resaleFilter === "resale") out = out.filter((r) => r.resale);
    if (onlyFlagged) out = out.filter((r) => r.flagged);
    if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "links") out = [...out].sort((a, b) => b.linkedCount - a.linkedCount);
    else if (sort === "spread") {
      out = [...out].sort((a, b) => (b.spreadRatio ?? 0) - (a.spreadRatio ?? 0));
    } else {
      out = [...out].sort((a, b) => b.usd12m - a.usd12m);
    }
    return out;
  }, [rows, trimmed, superCat, resaleFilter, onlyFlagged, sort]);

  const matchedUsd = useMemo(
    () => filtered.reduce((s, r) => s + r.usd12m, 0),
    [filtered]
  );
  const matchedFlagged = useMemo(
    () => filtered.filter((r) => r.flagged).length,
    [filtered]
  );
  const anyFilterActive =
    trimmed.length > 0 ||
    superCat !== "all" ||
    resaleFilter !== "all" ||
    onlyFlagged;

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setResaleFilter("all");
    setOnlyFlagged(false);
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
            placeholder="Filter by name, parent, category, linked vendor or SKU"
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
                  {" "}&middot; <strong>{fmtCount(matchedFlagged)}</strong> flagged
                </>
              ) : null}
            </>
          )}
        </span>
      </div>

      <div className="kf-review__toolbar" role="toolbar" aria-label="Sort and filter">
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
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={superCat === c}
                aria-pressed={superCat === c}
                className={`kf-chip${superCat === c ? " kf-chip--on" : ""}${n === 0 ? " kf-chip--empty" : ""}`}
                onClick={() => setSuperCat(c)}
                disabled={n === 0}
              >
                {c} <span className="kf-chip__count">{fmtCount(n)}</span>
              </button>
            );
          })}
        </div>

        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Resale and flag filters">
          <button
            type="button"
            role="radio"
            aria-checked={resaleFilter === "recipe"}
            aria-pressed={resaleFilter === "recipe"}
            className={`kf-chip${resaleFilter === "recipe" ? " kf-chip--on" : ""}`}
            onClick={() => setResaleFilter((v) => (v === "recipe" ? "all" : "recipe"))}
          >
            Recipe only
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={resaleFilter === "resale"}
            aria-pressed={resaleFilter === "resale"}
            className={`kf-chip${resaleFilter === "resale" ? " kf-chip--on" : ""}`}
            onClick={() => setResaleFilter((v) => (v === "resale" ? "all" : "resale"))}
          >
            Resale only
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={onlyFlagged}
            aria-pressed={onlyFlagged}
            className={`kf-chip kf-chip--warn${onlyFlagged ? " kf-chip--on" : ""}`}
            onClick={() => setOnlyFlagged((v) => !v)}
            title="Only masters flagged by the bad-pack radar"
          >
            Flagged only
          </button>
          {anyFilterActive ? (
            <button type="button" className="kf-btn kf-btn--ghost kf-btn--sm" onClick={clearAll}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

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
        <>
          <div className="kf-masters__head" aria-hidden>
            <span className="kf-masters__head-chev" />
            <span>Ingredient</span>
            <span className="kf-masters__head-num">Per-unit</span>
            <span className="kf-masters__head-num">Spread</span>
            <span className="kf-masters__head-num">Links</span>
            <span className="kf-masters__head-num">12-mo spend</span>
          </div>
          <ul className="kf-masters__list" aria-label="Masters">
            {filtered.map((row) => (
              <li key={row.id}>
                <MasterCard row={row} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function MasterCard({ row }: { row: MasterRow }) {
  const uom = uomLabel(row.baseUom);
  return (
    <details className={`kf-master${row.flagged ? " kf-master--flagged" : ""}`}>
      <summary className="kf-master__row">
        <span className="kf-master__chev" aria-hidden>
          <ChevronDown size={16} strokeWidth={1.75} />
        </span>
        <span className="kf-master__name-col">
          <strong className="kf-master__name">{row.name}</strong>
          <span className="kf-master__sub">
            {row.category ? row.category : <em className="kf-muted">Needs category</em>}
            {row.parent ? <> &middot; {row.parent}</> : null}
            {row.resale ? <> &middot; <span className="kf-pill kf-pill--muted">Resale</span></> : null}
          </span>
        </span>

        <span className="kf-master__price-col">
          {row.avgPerBase != null ? (
            <>
              <strong>{fmtUsd(row.avgPerBase)}</strong>
              <span className="kf-muted"> / {uom}</span>
            </>
          ) : (
            <span className="kf-muted">- / {row.baseUnit?.toLowerCase() ?? "unit"}</span>
          )}
          {row.flagged ? (
            <span
              className="kf-conf-chip kf-conf-chip--low kf-master__flag"
              title={`Bad-pack radar: ${row.flagReason}`}
            >
              check
            </span>
          ) : null}
        </span>

        <span className="kf-master__spread-col">
          {row.minPerBase != null && row.maxPerBase != null ? (
            <>
              <span className="kf-cell-sub">
                {fmtUsd(row.minPerBase)} - {fmtUsd(row.maxPerBase)}
              </span>
              {row.spreadRatio != null ? (
                <span
                  className={`kf-cell-sub kf-cell-sub--dim${row.spreadRatio > 3 ? " kf-cell-sub--note" : ""}`}
                >
                  {row.spreadRatio.toFixed(1)}x
                </span>
              ) : null}
            </>
          ) : (
            <span className="kf-muted">-</span>
          )}
        </span>

        <span className="kf-master__links-col">{fmtCount(row.linkedCount)}</span>
        <span className="kf-master__spend-col">{fmtUsd(row.usd12m)}</span>
      </summary>

      {row.linkedCount === 0 ? (
        <div className="kf-master__empty">
          <span className="kf-muted">No links yet - awaiting confirmation in the review queue.</span>
        </div>
      ) : (
        <div className="kf-master__inner">
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: "var(--sp-sp-2)",
            }}
          >
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
                <th className="kf-table__num">Per-unit</th>
                <th className="kf-table__num">Annual $</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {row.linkedItems.map((li) => {
                const liUom = uomLabel(li.perBaseUom);
                const outlier =
                  row.avgPerBase != null &&
                  li.perBase != null &&
                  (li.perBase > row.avgPerBase * 3 || li.perBase < row.avgPerBase / 3);
                return (
                  <tr
                    key={li.id}
                    className={outlier || li.unitMismatch ? "kf-master__inner-row--outlier" : undefined}
                  >
                    <td title={li.name}>
                      <span className="kf-cell-ellipsis">{li.name}</span>
                      {li.unitMismatch ? (
                        <span className="kf-cell-sub kf-cell-sub--note">
                          unit mismatch vs master ({li.perBaseUom ?? "?"})
                        </span>
                      ) : outlier ? (
                        <span className="kf-cell-sub kf-cell-sub--note">outlier vs blend</span>
                      ) : null}
                    </td>
                    <td>{li.vendor}</td>
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
                      <span
                        style={{
                          display: "inline-flex",
                          gap: "var(--sp-sp-2)",
                          justifyContent: "flex-end",
                        }}
                      >
                        <RowSendBackButton itemId={li.id} itemName={li.name} />
                        <a
                          href={`/stockpot/ingredients/vendor-items?drawer=${li.id}`}
                          className="kf-btn kf-btn--line kf-btn--sm"
                        >
                          Open
                        </a>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
