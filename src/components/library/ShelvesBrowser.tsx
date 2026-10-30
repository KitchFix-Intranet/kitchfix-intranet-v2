"use client";

// Shelves - F2 (V7). A real catalogue table (Number / Document /
// Kind / Version / Spanish), with a left-nav for shelf + kind +
// language. No Academy marks (R-AC26).
//
// Sort: Recent (updated_at desc) or A-Z (title asc). Default Recent.
//
// Spanish column: a doc has a Spanish sibling when the catalogue
// contains a doc whose id ends in "-ES" with the same prefix. We
// build the set once from the shelves prop.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { LibraryBody } from "@/lib/academy/library";
import { humanizeDocClass } from "@/lib/academy/docClass";

type Props = { shelves: LibraryBody["shelves"] };

type ShelfDoc = LibraryBody["shelves"][number]["docs"][number];

type Axis =
  | { kind: "all" }
  | { kind: "shelf"; name: string }
  | { kind: "kind"; label: string }
  | { kind: "lang"; code: "en-only" | "has-es" };

function docKindLabel(d: ShelfDoc): string {
  return humanizeDocClass(d.doc_class) || "Document";
}

function stripEsSuffix(id: string): string {
  return id.endsWith("-ES") ? id.slice(0, -3) : id;
}

export function ShelvesBrowser({ shelves }: Props) {
  const [axis, setAxis] = useState<Axis>({ kind: "all" });
  const [sort, setSort] = useState<"recent" | "atoz">("recent");

  // Flat set of docs, deduped by id. Also build "has-es" set keyed on
  // the English doc id - a Spanish sibling (id ends with -ES) marks
  // its English counterpart.
  const { allDocs, hasEs, kindCounts, langCounts } = useMemo(() => {
    const seen = new Set<string>();
    const docs: Array<ShelfDoc & { shelf: string }> = [];
    const hasEs = new Set<string>();
    for (const s of shelves) {
      for (const d of s.docs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        docs.push({ ...d, shelf: s.name });
      }
    }
    for (const d of docs) {
      if (d.id.endsWith("-ES")) hasEs.add(stripEsSuffix(d.id));
    }
    const english = docs.filter((d) => !d.id.endsWith("-ES"));
    const kindCounts = new Map<string, number>();
    for (const d of english) {
      const k = docKindLabel(d);
      kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
    }
    const langCounts = {
      "en-only": english.filter((d) => !hasEs.has(d.id)).length,
      "has-es":  english.filter((d) =>  hasEs.has(d.id)).length,
    };
    return { allDocs: docs, hasEs, kindCounts, langCounts };
  }, [shelves]);

  // Visible rows under the current axis. Hide Spanish siblings in
  // the main table - they are a column, not a row.
  const visibleDocs = useMemo(() => {
    const base = allDocs.filter((d) => !d.id.endsWith("-ES"));
    let filtered = base;
    if (axis.kind === "shelf") {
      filtered = base.filter((d) => d.shelf === axis.name);
    } else if (axis.kind === "kind") {
      filtered = base.filter((d) => docKindLabel(d) === axis.label);
    } else if (axis.kind === "lang") {
      filtered =
        axis.code === "en-only"
          ? base.filter((d) => !hasEs.has(d.id))
          : base.filter((d) => hasEs.has(d.id));
    }
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "atoz") return a.title.localeCompare(b.title);
      const au = (a.updated_at || "") as string;
      const bu = (b.updated_at || "") as string;
      return bu.localeCompare(au);
    });
    return sorted;
  }, [allDocs, hasEs, axis, sort]);

  const summaryKick = useMemo(() => {
    if (axis.kind === "all") return "documents in the live catalogue";
    if (axis.kind === "shelf") return `documents on ${axis.name}`;
    if (axis.kind === "kind") return `${axis.label} documents`;
    return axis.code === "en-only" ? "English-only documents" : "documents with a Spanish version";
  }, [axis]);

  const englishCount = allDocs.filter((d) => !d.id.endsWith("-ES")).length;

  return (
    <div className="kf-shelves-grid">
      <nav className="kf-shelf-nav" aria-label="Browse">
        <div className="kf-shelf-nav__group">
          <button
            type="button"
            className={`kf-shelf-nav__btn${axis.kind === "all" ? " kf-shelf-nav__btn--on" : ""}`}
            onClick={() => setAxis({ kind: "all" })}
            aria-pressed={axis.kind === "all"}
          >
            <span>All documents</span>
            <span className="kf-shelf-nav__count">{englishCount}</span>
          </button>
        </div>
        <div className="kf-shelf-nav__group" role="group" aria-label="By shelf">
          <span className="kf-shelf-nav__group-head">Shelf</span>
          {shelves.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`kf-shelf-nav__btn${axis.kind === "shelf" && axis.name === s.name ? " kf-shelf-nav__btn--on" : ""}`}
              onClick={() => setAxis({ kind: "shelf", name: s.name })}
              aria-pressed={axis.kind === "shelf" && axis.name === s.name}
            >
              <span>{s.name}</span>
              <span className="kf-shelf-nav__count">{s.docs.filter((d) => !d.id.endsWith("-ES")).length}</span>
            </button>
          ))}
        </div>
        <div className="kf-shelf-nav__group" role="group" aria-label="By kind">
          <span className="kf-shelf-nav__group-head">Kind</span>
          {[...kindCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => (
            <button
              key={label}
              type="button"
              className={`kf-shelf-nav__btn${axis.kind === "kind" && axis.label === label ? " kf-shelf-nav__btn--on" : ""}`}
              onClick={() => setAxis({ kind: "kind", label })}
              aria-pressed={axis.kind === "kind" && axis.label === label}
            >
              <span>{label}</span>
              <span className="kf-shelf-nav__count">{count}</span>
            </button>
          ))}
        </div>
        <div className="kf-shelf-nav__group" role="group" aria-label="By language">
          <span className="kf-shelf-nav__group-head">Language</span>
          <button
            type="button"
            className={`kf-shelf-nav__btn${axis.kind === "lang" && axis.code === "en-only" ? " kf-shelf-nav__btn--on" : ""}`}
            onClick={() => setAxis({ kind: "lang", code: "en-only" })}
            aria-pressed={axis.kind === "lang" && axis.code === "en-only"}
          >
            <span>English only</span>
            <span className="kf-shelf-nav__count">{langCounts["en-only"]}</span>
          </button>
          <button
            type="button"
            className={`kf-shelf-nav__btn${axis.kind === "lang" && axis.code === "has-es" ? " kf-shelf-nav__btn--on" : ""}`}
            onClick={() => setAxis({ kind: "lang", code: "has-es" })}
            aria-pressed={axis.kind === "lang" && axis.code === "has-es"}
          >
            <span>Has Spanish</span>
            <span className="kf-shelf-nav__count">{langCounts["has-es"]}</span>
          </button>
        </div>
      </nav>

      <section className="kf-lib-table" aria-label="Catalogue">
        <header className="kf-lib-table__sum">
          <span className="kf-lib-table__sum-count">{visibleDocs.length}</span>
          <span className="kf-lib-table__sum-kick">{summaryKick}</span>
          <div className="kf-lib-table__sort" role="group" aria-label="Sort">
            <button
              type="button"
              className={`kf-lib-table__sort-btn${sort === "recent" ? " kf-lib-table__sort-btn--on" : ""}`}
              onClick={() => setSort("recent")}
              aria-pressed={sort === "recent"}
            >
              Recent
            </button>
            <button
              type="button"
              className={`kf-lib-table__sort-btn${sort === "atoz" ? " kf-lib-table__sort-btn--on" : ""}`}
              onClick={() => setSort("atoz")}
              aria-pressed={sort === "atoz"}
            >
              A - Z
            </button>
          </div>
        </header>
        <div className="kf-lib-head" role="row" aria-label="Column headers">
          <span role="columnheader">Number</span>
          <span role="columnheader">Document</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader" className="kf-lib-head__r">Version</span>
          <span role="columnheader">Spanish</span>
        </div>
        {visibleDocs.length === 0 ? (
          <div className="kf-lib-row" style={{ cursor: "default", gridTemplateColumns: "minmax(0, 1fr)" }}>
            <span className="kf-lib-row__muted">No documents in this view.</span>
          </div>
        ) : (
          visibleDocs.map((d) => {
            const kindLabel = docKindLabel(d);
            const version = d.version != null ? `v${d.version}` : "-";
            const es = hasEs.has(d.id);
            return (
              <Link
                key={d.id}
                href={`/library/${d.id}`}
                className="kf-lib-row"
                prefetch={false}
                role="row"
              >
                <span className="kf-lib-row__id" role="cell">{d.id}</span>
                <span role="cell">
                  <span className="kf-lib-row__title" title={d.title}>{d.title}</span>
                  {d.card_line ? <span className="kf-lib-row__sub">{d.card_line}</span> : null}
                </span>
                <span className="kf-lib-row__muted" role="cell">{kindLabel}</span>
                <span className="kf-lib-row__r kf-lib-row__muted" role="cell">{version}</span>
                <span role="cell">
                  {es ? <span className="kf-lib-row__es">ES</span> : <span className="kf-lib-row__muted">-</span>}
                </span>
              </Link>
            );
          })
        )}
      </section>
    </div>
  );
}
