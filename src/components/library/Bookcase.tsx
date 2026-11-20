"use client";

// Bookcase - Library L2.
//
// One page. Server composes the band + phone heading and hands this
// client component the shelves + initial `q`; this component owns
// the search, the shelf nav (scroll-spy + jump-to), and the shelf /
// no-results states.
//
// Access:  server already applied L1's may-read rule before the data
// arrived here. Nothing on the wire is restricted for a
// reads_unrestricted viewer; the search index is the same set.
//
// Search: `?q=` in the URL; typing updates the URL via
// router.replace so Back keeps the term. No personal data in the
// search param - it is whatever the user typed. We match across
// title, number, card_line, summary and keywords, document-level
// only (R-AC10).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Search as SearchIcon,
  X as ClearIcon,
  FileText,
  BookOpen,
  ClipboardList,
  StickyNote,
  AlignLeft,
  FileCheck,
  FileSignature,
  Megaphone,
  CheckSquare,
  Wrench,
} from "lucide-react";
import type { LibraryBody, LibraryDoc } from "@/lib/academy/library";
import { humanizeDocClass } from "@/lib/academy/docClass";

type Props = {
  shelves: LibraryBody["shelves"];
  totalDocs: number;
  totalShelves: number;
  initialQuery: string;
};

// A kind icon per doc_class. Shapes, not colours.
function KindIcon({ code }: { code: string | null }): React.ReactNode {
  const c = String(code || "").toUpperCase();
  const size = 18;
  const strokeWidth = 1.75;
  const common = { size, strokeWidth, "aria-hidden": true as const };
  switch (c) {
    case "PB": return <BookOpen {...common} />;
    case "SOP": return <ClipboardList {...common} />;
    case "POL": return <FileText {...common} />;
    case "REF": return <AlignLeft {...common} />;
    case "TPL": return <StickyNote {...common} />;
    case "REC": return <FileCheck {...common} />;
    case "FORM": return <FileSignature {...common} />;
    case "POST": return <Megaphone {...common} />;
    case "STD": return <FileText {...common} />;
    case "AGR": return <FileSignature {...common} />;
    case "CHK": return <CheckSquare {...common} />;
    default: return <Wrench {...common} />;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function pl(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function matches(doc: LibraryDoc, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const kw = Array.isArray(doc.keywords) ? doc.keywords.join(" ") : "";
  const hay = [
    doc.id,
    doc.title,
    doc.card_line ?? "",
    doc.summary ?? "",
    kw,
    humanizeDocClass(doc.doc_class),
  ]
    .join(" ")
    .toLowerCase();
  for (const t of terms) {
    if (!hay.includes(t)) return false;
  }
  return true;
}

export function Bookcase({ shelves, totalDocs, totalShelves, initialQuery }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState<string>(initialQuery);
  const [activeShelf, setActiveShelf] = useState<string>(shelves[0]?.name ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep local state in step with the URL (Back / Forward).
  useEffect(() => {
    const urlQ = searchParams?.get("q") ?? "";
    if (urlQ !== query) setQuery(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Debounced URL sync so every keystroke does not push history.
  useEffect(() => {
    const t = setTimeout(() => {
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      if (query.trim().length > 0) sp.set("q", query);
      else sp.delete("q");
      const qs = sp.toString();
      router.replace(qs ? `/library?${qs}` : "/library", { scroll: false });
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [query],
  );
  const searching = terms.length > 0;

  const filteredShelves = useMemo(() => {
    if (!searching) return shelves;
    return shelves
      .map((s) => ({
        ...s,
        docs: s.docs.filter((d) => matches(d, terms)),
      }))
      .filter((s) => s.docs.length > 0)
      .map((s) => ({ ...s, count: s.docs.length }));
  }, [shelves, terms, searching]);

  const matchCount = useMemo(
    () => filteredShelves.reduce((a, s) => a + s.docs.length, 0),
    [filteredShelves],
  );

  // Scroll-spy for the shelf list. One observer across shelf
  // heading anchors; nearest to the top wins. Phones do not render
  // the shelf list, so the observer is cheap when unused.
  const shelfRefs = useRef(new Map<string, HTMLElement>());
  const setShelfRef = useCallback((name: string) => (el: HTMLElement | null) => {
    if (el) shelfRefs.current.set(name, el);
    else shelfRefs.current.delete(name);
  }, []);

  useEffect(() => {
    if (searching) return; // scroll-spy only in resting state
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) {
          const name = visible.target.getAttribute("data-shelf") ?? "";
          if (name) setActiveShelf(name);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.1, 0.5, 1] },
    );
    shelfRefs.current.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [filteredShelves, searching]);

  function jumpToShelf(name: string) {
    const el = shelfRefs.current.get(name);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const heading = el.querySelector<HTMLHeadingElement>(".kf-lb-shelf__h h2");
    if (heading) {
      heading.focus({ preventScroll: true });
    }
    setActiveShelf(name);
  }

  function clearSearch() {
    setQuery("");
    inputRef.current?.focus();
  }

  const trimmed = query.trim();

  return (
    <>
      <div className="kf-lb-tools">
        <label className="kf-lb-search" aria-label="Search the Library">
          <SearchIcon size={18} strokeWidth={1.75} aria-hidden />
          <input
            ref={inputRef}
            id="kf-lb-q"
            type="search"
            className="kf-lb-search__input"
            placeholder="Search the Library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Search the Library"
          />
          {trimmed.length > 0 ? (
            <button
              type="button"
              className="kf-lb-search__clear"
              aria-label="Clear search"
              onClick={clearSearch}
            >
              <ClearIcon size={18} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
        </label>

        {/* On phones the shelf list is a select-ish strip at the top of the page. */}
        <nav className="kf-lb-shelfjump kf-only-phone" aria-label="Jump to shelf">
          <ul>
            {filteredShelves.map((s) => (
              <li key={s.name}>
                <a href={`#shelf-${slug(s.name)}`}>
                  <span>{s.name}</span>
                  <span className="kf-lb-shelfjump__count">{s.count}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/*
        One status node for sighted and screen-reader users both.
        Visible when searching; role="status" announces the exact
        same words once (no second sr-only region, so no double read).
      */}
      {searching ? (
        <p className="kf-lb-matchcount" role="status">
          {matchCount === 0
            ? `No documents match "${trimmed}"`
            : `${pl(matchCount, "document")} match "${trimmed}"`}
        </p>
      ) : null}

      <div className="kf-lb-lay">
        <aside className="kf-lb-rail kf-only-desktop" aria-label="Shelves">
          <div className="kf-lb-rail__inner">
            <div className="kf-lb-rail__head">
              <span className="kf-lb-rail__title">Shelves</span>
              <span className="kf-lb-rail__meta">{filteredShelves.length}</span>
            </div>
            <ul className="kf-lb-shelfnav" role="list">
              {filteredShelves.map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    className="kf-lb-shelfnav__btn"
                    aria-current={activeShelf === s.name ? "true" : undefined}
                    onClick={() => jumpToShelf(s.name)}
                  >
                    <span className="kf-lb-shelfnav__t">{s.name}</span>
                    <span className="kf-lb-shelfnav__c">{s.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="kf-lb-main">
          {searching && matchCount === 0 ? (
            // No role="status" on this block: the matchcount <p>
            // above already carries the same announcement with
            // role="status". Two status regions with the same
            // words made some screen readers read them twice; this
            // block is a plain <section> so the SR announces the
            // sentence once from the matchcount line.
            <section className="kf-empty" aria-label="No matches">
              <div className="kf-empty__icon" aria-hidden />
              <div>
                <h3 className="kf-empty__title">
                  No documents match &ldquo;{trimmed}&rdquo;
                </h3>
                <p className="kf-empty__body">
                  Try a shorter word, or a document number like POL-001. Clear the
                  search to see the shelves again.
                </p>
              </div>
              <button
                type="button"
                className="kf-btn kf-btn--primary"
                onClick={clearSearch}
              >
                Clear search
              </button>
            </section>
          ) : filteredShelves.length === 0 ? (
            <section className="kf-empty" role="status" aria-label="Nothing readable">
              <div className="kf-empty__icon" aria-hidden />
              <div>
                <h3 className="kf-empty__title">Nothing on your shelves yet</h3>
                <p className="kf-empty__body">
                  Live documents land here as they are approved. Ask your regional
                  director if you were expecting one.
                </p>
              </div>
            </section>
          ) : (
            <div className="kf-lb-case">
              {filteredShelves.map((s) => (
                <section
                  key={s.name}
                  id={`shelf-${slug(s.name)}`}
                  className="kf-lb-shelf"
                  data-shelf={s.name}
                  ref={setShelfRef(s.name)}
                  aria-label={s.name}
                >
                  <header className="kf-lb-shelf__h">
                    <h2 tabIndex={-1}>{s.name}</h2>
                    <span className="kf-lb-shelf__meta">
                      {pl(s.docs.length, "document")}
                    </span>
                  </header>
                  <ul className="kf-lb-books" role="list">
                    {s.docs.map((d) => (
                      <li key={d.id}>
                        <Tile doc={d} searchQuery={trimmed} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </main>
      </div>

    </>
  );
}

function Tile({ doc, searchQuery }: { doc: LibraryDoc; searchQuery: string }) {
  const kindLabel = humanizeDocClass(doc.doc_class) || "Document";
  const versionLabel = doc.version != null ? `v${doc.version}` : null;
  // L3 back-link chain: when the viewer is searching, carry ?q=
  // onto the tile's href so BackLink on the document page resolves
  // to the "Back to search" variant and lands them back at
  // /library?q=<term>. Nothing personal in the param - it is the
  // user's own typed text and already in their URL.
  const q = searchQuery.trim();
  const href = q.length > 0
    ? `/library/${doc.id}?q=${encodeURIComponent(q)}`
    : `/library/${doc.id}`;
  return (
    <Link href={href} className="kf-lb-book" prefetch={false}>
      <div className="kf-lb-book__top">
        <span className="kf-lb-book__g" aria-hidden>
          <KindIcon code={doc.doc_class} />
        </span>
        <span className="kf-lb-book__n">{doc.id}</span>
        <span className="kf-lb-book__k">{kindLabel}</span>
      </div>
      <span className="kf-lb-book__t">{doc.title}</span>
      {doc.card_line ? (
        <span className="kf-lb-book__l">{doc.card_line}</span>
      ) : null}
      <div className="kf-lb-book__f">
        {versionLabel ? (
          <span className="kf-lb-book__v">Version {doc.version}</span>
        ) : null}
        {doc.has_es ? (
          <span className="kf-lb-book__mark" aria-label="Has a Spanish copy">
            <span className="kf-lb-book__mark-shape kf-lb-book__mark-shape--es" aria-hidden />
            Has a Spanish copy
          </span>
        ) : null}
        {doc.posted_on_wall ? (
          <span className="kf-lb-book__mark" aria-label="Posted on the wall">
            <span className="kf-lb-book__mark-shape kf-lb-book__mark-shape--wall" aria-hidden />
            Posted on the wall
          </span>
        ) : null}
      </div>
    </Link>
  );
}
