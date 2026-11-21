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

import { useMemo, useState, type ReactNode } from "react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { SUPER_CATEGORIES } from "@/lib/ingredients/categories";
import { Search } from "./Search";
import { SortMenu, type SortKey } from "./SortMenu";

// A copy of the shape the server passes in. Keeping it narrow (not the
// full ReviewCardGroup) so no stray React-element props leak in.
export type ReviewFilterGroup = {
  key: string;
  kind: "existing" | "new";
  ingredientName: string | null;
  ingredientParent: string | null;
  // Super-category (null = "Needs category") and resale flag feed the
  // category chips + the resale / needs-category quick filters. For an
  // existing-ingredient group this is the ingredient's own category; for
  // an ai-new group it is derived from the matcher's proposed parent via
  // categoryForParent (see ReviewQueue.toFilterGroup).
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

// Train 5a / F23: one Sort vocabulary. Review's "dollars first"
// stays the default; the key the client toggles between is "spend"
// (the shared SortMenu's word for the same order) and "name".
type SortMode = Extract<SortKey, "spend" | "name">;
type KindFilter = "all" | "needs" | "resale";
const REVIEW_SORT_OPTIONS: readonly SortMode[] = ["spend", "name"];

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
  notFoodCard,
}: {
  groups: ReviewFilterGroup[];
  cards: RenderedCard[];
  totals: Totals;
  // T5b item 3: the not-food card is one card that is not drawn
  // when a search or filter is on. It sits last in the list. Null
  // when there are no proposed ai-notfood items.
  notFoodCard?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("spend");
  const [superCat, setSuperCat] = useState<string | "all">("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  // Train 5a / F22: "/" focus and Esc clear live inside the shared
  // Search component now; this file keeps no input ref.

  // Per-super counts over the FULL group list (not the search-filtered
  // one), so the chip label always shows the total available under that
  // super. "All" matches every group; "Needs category" counts groups
  // with no derivable super-category (the proposed parent is absent
  // from CATEGORY_BY_PARENT, or there is no proposed parent); "Resale"
  // counts groups with resale=true.
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
    if (sort === "name") {
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
  }

  return (
    <>
      <div className="kf-review__search">
        {/* Train 5a / F22: one Search component, used on every working
            tab. "/" focuses it, Esc clears it, filters as you type.
            The old .kf-field/.kf-review__search-field shape retires. */}
        <Search
          kind="controlled"
          value={query}
          onChange={(v) => setQuery(v)}
          placeholder="Filter by ingredient, vendor, or SKU - try premium or chicken"
          label="Filter proposals"
        />
        <span className="kf-review__search-count" aria-live="polite">
          {!anyFilterActive ? (
            <>
              {/* T6 ruling 11: the count line reads the same number as
                  the @topbar header (totals.groups), which includes the
                  not-food card when it has items. ReviewFilter's groups
                  prop is the regular groups only; totals.groups is the
                  authoritative number from the one cached loader. */}
              <strong>{fmtCount(totals.groups)}</strong> groups · <strong>{fmtUsd(totals.groupedUsd)}</strong>
              {/* Train 5a / ruling 5: the retired IdentBand carried a
                  "Flagged not food" fact (the matcher's ai-notfood
                  pile). It moves here, once, as plain text. */}
              {totals.notFood > 0 ? (
                <> · <strong>{fmtCount(totals.notFood)}</strong> flagged not food</>
              ) : null}
            </>
          ) : (
            <>
              <strong>{fmtCount(filtered.length)}</strong> of {fmtCount(totals.groups)} groups ·{" "}
              <strong>{fmtUsd(matchedUsd)}</strong> matching
            </>
          )}
        </span>
      </div>

      {/* Toolbar: sort toggle on the left, category chips in the
          middle, resale/needs quick-filters on the right. Everything is
          purely client-side over the already-loaded groups and composes
          AND with the search box above.
          Polish 3: a quiet "Sort" kicker before the sort chips keeps
          the sort group from reading as a selected filter chip. The
          existing kf-chips__sep hairline between sort and categories
          stays - the kicker names what the group is, the hairline
          marks where the groups split. */}
      <div className="kf-review__toolbar" role="toolbar" aria-label="Sort and filter">
        {/* Train 5a / F23: one Sort control, the shared labelled menu.
            Review's two prior chip radios ("Dollars"/"A-Z") retire -
            the vocabulary is the SORT_WORDS set that every tab uses. */}
        <SortMenu
          value={sort}
          options={REVIEW_SORT_OPTIONS}
          onChange={(v) => setSort(v)}
        />

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
            // Polish 3: hide zero-count super-categories entirely.
            // Previously they rendered as disabled "Dairy 0 / Bakery
            // 0 / Beverages 0" chips - noisy and the user can't
            // click them anyway. The chip rail now shows only
            // categories that actually have groups today. If a
            // category earns a group it reappears on the next
            // router.refresh.
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

        <div className="kf-review__toolbar-group" role="radiogroup" aria-label="Kind filter">
          {/* Polish 3 rule, applied to the kind chips: a zero-count chip is
              noise and cannot be clicked to anything useful. Kept visible
              while it is the ACTIVE filter so the user always has a control
              to leave the filtered view. A group with an unmapped parent
              makes it reappear on the next router.refresh. */}
          {(needsCount > 0 || kindFilter === "needs") && (
            <button
              type="button"
              role="radio"
              aria-checked={kindFilter === "needs"}
              aria-pressed={kindFilter === "needs"}
              className={`kf-chip kf-chip--warn${kindFilter === "needs" ? " kf-chip--on" : ""}`}
              onClick={() => setKindFilter((v) => (v === "needs" ? "all" : "needs"))}
              title="Groups with no derivable super-category - the proposed parent is not in the category map"
            >
              Needs category <span className="kf-chip__count">{fmtCount(needsCount)}</span>
            </button>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={kindFilter === "resale"}
            aria-pressed={kindFilter === "resale"}
            className={`kf-chip${kindFilter === "resale" ? " kf-chip--on" : ""}`}
            onClick={() => setKindFilter((v) => (v === "resale" ? "all" : "resale"))}
            title="Groups whose ingredient is flagged retail"
          >
            Retail <span className="kf-chip__count">{fmtCount(resaleCount)}</span>
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
        <>
          {/* T5b item 1: the four exits are explained once, in one
              line above the list of cards. The legend line on each
              card is retired. */}
          <p className="kf-helpline">
            <b>Not for recipes:</b> Retail is sold as-is. One-off was bought
            once. Archive is a mistake or a dead item. Not food is fees and
            supplies. Every decision can be undone, here or in Recent
            decisions.
          </p>
          <ul className="kf-review__groups" aria-label="Groups">
            {filtered.map((g) => (
              <li key={g.key}>{cardByKey.get(g.key)}</li>
            ))}
            {/* T5b item 3: the not-food card is one card, last in
                the list, drawn only when no search or filter is on.
                It is one group for the header's "groups to review"
                count (see loadReview's totals.groups). */}
            {!anyFilterActive && notFoodCard ? <li key="nf">{notFoodCard}</li> : null}
          </ul>
        </>
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
