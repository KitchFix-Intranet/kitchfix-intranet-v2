"use client";

// LibraryFind. Document-level search over the Library's 82 live
// docs - the server page hands over a flat index (title, card_line,
// summary, keywords, humanized doc_class) and this island filters
// in memory on each keystroke. 82 rows fit comfortably; no round-
// trip per keystroke, no FTS, no index column.
//
// Section-level search ("find the sentence inside a document") is
// a later train - it needs a content index over document_content
// that does not exist yet. Do NOT reach for document_content here.
//
// Three states: empty query (resting prompt + optional Start Here
// trains-you set), with-matches (count + list), no-match (plain
// state + link to Shelves). Red is for blocks only - no-match is
// not red (R-AC19 holds across Library too).

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search as SearchIcon } from "lucide-react";
import type { LibraryIndexDoc } from "@/lib/academy/library";
import { humanizeDocClass } from "@/lib/academy/docClass";

type Props = {
  docs: LibraryIndexDoc[];
};

// Build the lowercase haystack for one doc once. Keywords are a
// text[] - join them with spaces so the substring match treats them
// as free text alongside title/card_line/summary.
type IndexedDoc = LibraryIndexDoc & { haystack: string };

function buildIndex(docs: LibraryIndexDoc[]): IndexedDoc[] {
  return docs.map((d) => {
    const kw = Array.isArray(d.keywords) ? d.keywords.join(" ") : "";
    const haystack = [d.title, d.card_line ?? "", d.summary ?? "", kw]
      .join(" ")
      .toLowerCase();
    return { ...d, haystack };
  });
}

// Split on whitespace; require every term to appear in the haystack
// (AND). An empty query yields no terms and no results.
function matches(doc: IndexedDoc, terms: string[]): boolean {
  if (terms.length === 0) return false;
  for (const t of terms) {
    if (!doc.haystack.includes(t)) return false;
  }
  return true;
}

export function LibraryFind({ docs }: Props) {
  const index = useMemo(() => buildIndex(docs), [docs]);
  const [query, setQuery] = useState<string>("");

  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [query],
  );

  const results = useMemo(() => {
    if (terms.length === 0) return [] as IndexedDoc[];
    const hits = index.filter((d) => matches(d, terms));
    // Stable sort: title-matches first (lowercased title contains the
    // first term), then everything else, each alphabetically by title.
    const firstTerm = terms[0];
    return hits.sort((a, b) => {
      const aT = a.title.toLowerCase().includes(firstTerm) ? 0 : 1;
      const bT = b.title.toLowerCase().includes(firstTerm) ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return a.title.localeCompare(b.title);
    });
  }, [index, terms]);

  const trainsYou = useMemo(
    () => index.filter((d) => d.trains_you),
    [index],
  );

  const trimmed = query.trim();
  const empty = trimmed.length === 0;
  const matched = results.length;

  return (
    <div className="kf-find">
      <label className="kf-find__field" aria-label="Find a document">
        <SearchIcon size={18} strokeWidth={1.5} aria-hidden />
        <input
          type="search"
          className="kf-find__input"
          placeholder="Find a document - title, topic, or what you're trying to do"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label="Find a document"
        />
      </label>

      {empty ? (
        <section className="kf-find__resting" aria-label="How Find works">
          <p className="kf-find__resting-title">Type a word from a title, a topic, or what you&apos;re trying to do.</p>
          <p className="kf-find__resting-body">
            Find searches document titles, kickers, summaries and keywords across the live catalogue.
            To scan a document&apos;s contents, open it and jump by section.
          </p>
          {trainsYou.length > 0 ? (
            <div className="kf-find__start-here">
              <p className="kf-find__start-here-label">On your to-do list</p>
              <ul className="kf-find__results">
                {trainsYou.map((d) => (
                  <ResultRow key={d.id} doc={d} />
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : matched === 0 ? (
        <section className="kf-find__nomatch" aria-label="No matches">
          <p className="kf-find__nomatch-title">
            Nothing matches &ldquo;{trimmed}&rdquo;
          </p>
          <p className="kf-find__nomatch-body">
            Try a shorter word, or browse by shelf.
          </p>
          <Link href="/library/shelves" className="kf-btn kf-btn--primary">
            Browse the shelves
          </Link>
        </section>
      ) : (
        <section className="kf-find__results-wrap" aria-label={`${matched} matching documents`}>
          <p className="kf-find__count">
            {matched} document{matched === 1 ? "" : "s"}
          </p>
          <ul className="kf-find__results">
            {results.map((d) => (
              <ResultRow key={d.id} doc={d} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ResultRow({ doc }: { doc: IndexedDoc }) {
  return (
    <li>
      <Link
        href={`/library/${doc.id}`}
        className="kf-library__doc"
        prefetch={false}
      >
        <span
          className="kf-library__doc-class"
          aria-label={`Document class ${humanizeDocClass(doc.doc_class)}`}
        >
          {humanizeDocClass(doc.doc_class) || "Document"}
        </span>
        <span className="kf-library__doc-text">
          <span className="kf-library__doc-title">{doc.title}</span>
          {doc.card_line ? (
            <span className="kf-library__doc-sub">{doc.card_line}</span>
          ) : null}
        </span>
        <span className="kf-library__doc-flags">
          {doc.trains_you ? (
            <span
              className="kf-pill kf-pill--on-todo"
              title="On your to-do list"
            >
              On your to-do list
            </span>
          ) : null}
          <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
        </span>
      </Link>
    </li>
  );
}
