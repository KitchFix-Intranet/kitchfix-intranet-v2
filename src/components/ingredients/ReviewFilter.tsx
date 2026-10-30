"use client";

// Client-side search over the already-loaded review groups. No new DB
// query; the server loader already pulled every proposed row (paged at
// 1,000). This component owns the search draft, filters the group
// metadata by case-insensitive substring across the group header AND
// every member item, and shows only the matching cards. The cards are
// pre-rendered on the server and passed in as React nodes keyed by
// group - the client just picks which ones to display, so no card
// logic duplicates to the client bundle.
//
// Known limitation: covers only the first 1,000-row page the server
// returned (PostgREST cap). At 550 proposals today, the full queue.
// If the queue ever exceeds 1,000 (nightly matcher cron, step 7),
// swap to a server-side search.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownAZ, DollarSign, Search, X } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";

// A copy of the shape the server passes in. Keeping it narrow (not the
// full ReviewCardGroup) so no stray React-element props leak in.
export type ReviewFilterGroup = {
  key: string;
  kind: "existing" | "new";
  ingredientName: string | null;
  ingredientParent: string | null;
  // Super-category (null = "Uncategorized") and resale flag feed the
  // category chips + the resale / uncategorized quick filters.
  category: string | null;
  resale: boolean;
  proposedName: string | null;
  proposedParent: string | null;
  totalUsd12m: number;
  totalLines12m: number;
  memberCount: number;
  members: Array<{ name: string; vendor: string }>;
  lastSeen: string | null;
};

type SortMode = "dollars" | "alpha";
type KindFilter = "all" | "needs" | "resale";

type RenderedCard = { key: string; node: ReactNode };

type Totals = {
  items: number;
  usd: number;
  groups: number;
  notFood: number;
  groupedUsd: number;
};

// Normalize once per field. Substring match is already fast on strings
// this short; no need for a trigram index.
function matches(group: ReviewFilterGroup, needle: string): boolean {
  if (needle.length === 0) return true;
  const n = needle.toLowerCase();
  const headers = [
    group.ingredientName,
    group.ingredientParent,
    group.proposedName,
    group.proposedParent,
  ];
  for (const h of headers) {
    if (h && h.toLowerCase().includes(n)) return true;
  }
  for (const m of group.members) {
    if (m.name && m.name.toLowerCase().includes(n)) return true;
    if (m.vendor && m.vendor.toLowerCase().includes(n)) return true;
  }
  return false;
}

function displayName(g: ReviewFilterGroup): string {
  return (g.ingredientName ?? g.proposedName ?? "").toLowerCase();
}

export function ReviewFilter({
  groups,
  cards,
  totals,
}: {
  groups: ReviewFilterGroup[];
  cards: RenderedCard[];
  totals: Totals;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("dollars");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  // Per-super counts over the FULL group list (not the search-filtered
  // one), so the chip label always shows the total available under that
  // super. "All" matches every group; "Uncategorized" counts groups
  // with category=null (regardless of resale); "Resale" counts groups
  // with resale=true.
  const perSuperCount = useMemo(() => {
    const m = new Map<string, number>();
    m.set("all", groups.length);
    for (const c of SUPER_CATEGORIES) m.set(c, 0);
    for (const g of groups) {
      if (g.category && m.has(g.category)) m.set(g.category, (m.get(g.category) ?? 0) + 1);
    }
    return m;
  }, [groups]);
  const needsCount = useMemo(() => groups.filter((g) => g.category == null).length, [groups]);
  const resaleCount = useMemo(() => groups.filter((g) => g.resale).length, [groups]);

  // `/` focuses the input (unless the user is typing in another input).
  // Esc clears the current search and blurs the input.
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

  const trimmed = query.trim();
  // All three filters AND together, then the sort runs. Each is cheap
  // over the small group list; useMemo re-runs only when its own inputs
  // change. The sort returns a NEW array so React re-renders the <ul>
  // children in the new order.
  const filtered = useMemo(() => {
    let out = groups;
    if (trimmed.length > 0) out = out.filter((g) => matches(g, trimmed));
    if (superCat !== "all") out = out.filter((g) => g.category === superCat);
    if (kindFilter === "needs") out = out.filter((g) => g.category == null);
    else if (kindFilter === "resale") out = out.filter((g) => g.resale);
    if (sort === "alpha") {
      out = [...out].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    } else {
      out = [...out].sort((a, b) => b.totalUsd12m - a.totalUsd12m);
    }
    return out;
  }, [groups, trimmed, superCat, kindFilter, sort]);

  const matchedUsd = useMemo(() => filtered.reduce((s, g) => s + g.totalUsd12m, 0), [filtered]);
  const anyFilterActive =
    trimmed.length > 0 || superCat !== "all" || kindFilter !== "all";

  const cardByKey = useMemo(() => {
    const m = new Map<string, ReactNode>();
    for (const c of cards) m.set(c.key, c.node);
    return m;
  }, [cards]);

  const noneMatch = anyFilterActive && filtered.length === 0;

  function clearAll() {
    setQuery("");
    setSuperCat("all");
    setKindFilter("all");
    inputRef.current?.focus();
  }

  return (
    <>
      <div className="kf-review__search">
        <form
          className="kf-field kf-field--search kf-review__search-field"
          onSubmit={(e) => e.preventDefault()}
          role="search"
          aria-label="Filter proposals"
        >
          <span className="kf-field__icon" aria-hidden>
            <Search size={16} strokeWidth={1.5} />
          </span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Filter by ingredient, vendor, or SKU - try premium or chicken"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter proposals"
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
              <strong>{fmtCount(groups.length)}</strong> groups · <strong>{fmtUsd(totals.groupedUsd)}</strong>
            </>
          ) : (
            <>
              <strong>{fmtCount(filtered.length)}</strong> of {fmtCount(groups.length)} groups ·{" "}
              <strong>{fmtUsd(matchedUsd)}</strong> matching
            </>
          )}
        </span>
      </div>

      {/* Toolbar: sort toggle on the left, category chips in the
          middle, resale/needs quick-filters on the right. Everything is
          purely client-side over the already-loaded groups and composes
          AND with the search box above. */}
      <div className="kf-review__toolbar" role="toolbar" aria-label="Sort and filter">
        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Sort order">
          <button
            type="button"
            role="radio"
            aria-checked={sort === "dollars"}
            aria-pressed={sort === "dollars"}
            className={`kf-chip${sort === "dollars" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("dollars")}
            title="Highest dollars first"
          >
            <DollarSign size={14} strokeWidth={1.5} aria-hidden />
            <span>Dollars</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={sort === "alpha"}
            aria-pressed={sort === "alpha"}
            className={`kf-chip${sort === "alpha" ? " kf-chip--on" : ""}`}
            onClick={() => setSort("alpha")}
            title="Alphabetical by ingredient / proposed name"
          >
            <ArrowDownAZ size={14} strokeWidth={1.5} aria-hidden />
            <span>A-Z</span>
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

        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Kind filter">
          <button
            type="button"
            role="radio"
            aria-checked={kindFilter === "needs"}
            aria-pressed={kindFilter === "needs"}
            className={`kf-chip kf-chip--warn${kindFilter === "needs" ? " kf-chip--on" : ""}`}
            onClick={() => setKindFilter((v) => (v === "needs" ? "all" : "needs"))}
            title="Groups with no committed category yet - mostly new proposals. Creating the ingredient assigns its category automatically; it then drops out of this filter."
          >
            Uncategorized <span className="kf-chip__count">{fmtCount(needsCount)}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={kindFilter === "resale"}
            aria-pressed={kindFilter === "resale"}
            className={`kf-chip${kindFilter === "resale" ? " kf-chip--on" : ""}`}
            onClick={() => setKindFilter((v) => (v === "resale" ? "all" : "resale"))}
            title="Groups whose ingredient is flagged resale"
          >
            Resale <span className="kf-chip__count">{fmtCount(resaleCount)}</span>
          </button>
          {anyFilterActive ? (
            <button
              type="button"
              className="kf-btn kf-btn--ghost kf-btn--sm"
              onClick={clearAll}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {noneMatch ? (
        <div className="kf-empty kf-review__search-empty">
          <div>
            <div className="kf-empty__title">
              {trimmed.length > 0
                ? <>No groups match &ldquo;{trimmed}&rdquo;</>
                : <>No groups match the active filters</>}
            </div>
            <div className="kf-empty__body">
              {trimmed.length > 0
                ? "Try a vendor name, a cut (chicken, salmon), or a grade (premium). Press Esc to clear."
                : "Try switching super-category or clearing the quick filters."}
            </div>
          </div>
          <button
            type="button"
            className="kf-btn kf-btn--soft kf-btn--sm"
            onClick={clearAll}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="kf-review__groups" aria-label="Groups">
          {filtered.map((g) => (
            <li key={g.key}>{cardByKey.get(g.key)}</li>
          ))}
        </ul>
      )}

      <p className="kf-review__hint">
        {fmtUsdLong(matchedUsd)} across {fmtCount(filtered.length)} shown.
        {filtered.length > 0 && filtered[0].lastSeen
          ? ` Latest member last seen ${fmtDate(filtered[0].lastSeen)}.`
          : ""}
      </p>
    </>
  );
}
