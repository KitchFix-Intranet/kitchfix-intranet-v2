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
import { Search, X } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";

// A copy of the shape the server passes in. Keeping it narrow (not the
// full ReviewCardGroup) so no stray React-element props leak in.
export type ReviewFilterGroup = {
  key: string;
  kind: "existing" | "new";
  ingredientName: string | null;
  ingredientParent: string | null;
  proposedName: string | null;
  proposedParent: string | null;
  totalUsd12m: number;
  totalLines12m: number;
  memberCount: number;
  members: Array<{ name: string; vendor: string }>;
  lastSeen: string | null;
};

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
  const inputRef = useRef<HTMLInputElement>(null);

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
  const filtered = useMemo(() => {
    if (trimmed.length === 0) return groups;
    return groups.filter((g) => matches(g, trimmed));
  }, [groups, trimmed]);

  const matchedUsd = useMemo(() => filtered.reduce((s, g) => s + g.totalUsd12m, 0), [filtered]);

  const cardByKey = useMemo(() => {
    const m = new Map<string, ReactNode>();
    for (const c of cards) m.set(c.key, c.node);
    return m;
  }, [cards]);

  const noneMatch = trimmed.length > 0 && filtered.length === 0;

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
          {trimmed.length === 0 ? (
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

      {noneMatch ? (
        <div className="kf-empty kf-review__search-empty">
          <div>
            <div className="kf-empty__title">No groups match &ldquo;{trimmed}&rdquo;</div>
            <div className="kf-empty__body">
              Try a vendor name, a cut (chicken, salmon), or a grade (premium). Press Esc to clear.
            </div>
          </div>
          <button
            type="button"
            className="kf-btn kf-btn--soft kf-btn--sm"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            Clear filter
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
