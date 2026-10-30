"use client";

// Find - F2 (V7). Records, not paragraphs on cards.
//
// Three states:
//   - empty  -> most-recently-updated catalogue in the same hit2 row
//               shape (honest resting - no \"nothing to search\").
//   - matches -> summary strip (count in display face) + hit2 rows
//               with a <mark> on the first term.
//   - no-match -> honest empty with Browse Shelves CTA; not red.
//
// A scope switch (All / Playbooks / SOPs / Forms) narrows by the
// humanized doc_class. No Academy marks anywhere (R-AC26).

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search as SearchIcon } from "lucide-react";
import type { LibraryIndexDoc } from "@/lib/academy/library";
import { humanizeDocClass } from "@/lib/academy/docClass";

type Props = {
  docs: LibraryIndexDoc[];
};

type IndexedDoc = LibraryIndexDoc & { haystack: string; kindLabel: string };

const SCOPES = [
  { id: "all",       label: "All",       match: () => true as boolean },
  { id: "playbooks", label: "Playbooks", match: (d: IndexedDoc) => /playbook/i.test(d.kindLabel) },
  { id: "sops",      label: "SOPs",      match: (d: IndexedDoc) => /^sop/i.test(d.kindLabel) || /procedure/i.test(d.kindLabel) },
  { id: "forms",     label: "Forms",     match: (d: IndexedDoc) => /form/i.test(d.kindLabel) },
] as const;
type ScopeId = (typeof SCOPES)[number]["id"];

function buildIndex(docs: LibraryIndexDoc[]): IndexedDoc[] {
  return docs.map((d) => {
    const kw = Array.isArray(d.keywords) ? d.keywords.join(" ") : "";
    const kindLabel = humanizeDocClass(d.doc_class) || "Document";
    const haystack = [d.title, d.card_line ?? "", d.summary ?? "", kw, kindLabel]
      .join(" ")
      .toLowerCase();
    return { ...d, haystack, kindLabel };
  });
}

function matches(doc: IndexedDoc, terms: string[]): boolean {
  if (terms.length === 0) return false;
  for (const t of terms) {
    if (!doc.haystack.includes(t)) return false;
  }
  return true;
}

// Highlight the first term in a sentence. Returns React fragments so
// the <mark> stays live.
function highlight(text: string | null, firstTerm: string): React.ReactNode {
  if (!text) return null;
  if (!firstTerm) return text;
  const re = new RegExp(`(${firstTerm.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})`, "ig");
  const parts = text.split(re);
  return parts.map((p, i) =>
    p.toLowerCase() === firstTerm.toLowerCase() ? (
      <mark key={i}>{p}</mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function LibraryFind({ docs }: Props) {
  const index = useMemo(() => buildIndex(docs), [docs]);
  const [query, setQuery] = useState<string>("");
  const [scope, setScope] = useState<ScopeId>("all");

  const terms = useMemo(
    () =>
      query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [query],
  );

  const scoped = useMemo(() => {
    const matcher = SCOPES.find((s) => s.id === scope) ?? SCOPES[0];
    return index.filter((d) => matcher.match(d));
  }, [index, scope]);

  const results = useMemo(() => {
    if (terms.length === 0) return [] as IndexedDoc[];
    const hits = scoped.filter((d) => matches(d, terms));
    const firstTerm = terms[0];
    return hits.sort((a, b) => {
      const aT = a.title.toLowerCase().includes(firstTerm) ? 0 : 1;
      const bT = b.title.toLowerCase().includes(firstTerm) ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return a.title.localeCompare(b.title);
    });
  }, [scoped, terms]);

  // Empty query -> most-recently-updated catalogue in the same row
  // shape. Sort by updated_at desc; cap at 20 so the resting state
  // reads as a prompt, not the full catalogue.
  const resting = useMemo(() => {
    const sorted = [...scoped].sort((a, b) => {
      const au = (a.updated_at || "") as string;
      const bu = (b.updated_at || "") as string;
      return bu.localeCompare(au);
    });
    return sorted.slice(0, 20);
  }, [scoped]);

  const trimmed = query.trim();
  const empty = trimmed.length === 0;
  const matched = results.length;
  const firstTerm = terms[0] ?? "";

  return (
    <div className="kf-find">
      <div className="kf-lib-tools" role="toolbar" aria-label="Find">
        <label className="kf-find__field" aria-label="Find a document">
          <SearchIcon size={18} strokeWidth={1.5} aria-hidden />
          <input
            type="search"
            className="kf-find__input"
            placeholder="Find a document - title, topic, or what you're trying to do"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Find a document"
          />
        </label>
        <div className="kf-lib-scope" role="group" aria-label="Scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`kf-lib-scope__btn${scope === s.id ? " kf-lib-scope__btn--on" : ""}`}
              onClick={() => setScope(s.id)}
              aria-pressed={scope === s.id}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <>
          <header className="kf-lib-sum">
            <span className="kf-lib-sum__count">{resting.length}</span>
            <span className="kf-lib-sum__kick">most-recently-updated documents</span>
            <span className="kf-lib-sum__right">Type to narrow.</span>
          </header>
          <ul className="kf-hit-list" aria-label="Recently updated">
            {resting.map((d) => (
              <HitRow key={d.id} doc={d} firstTerm={firstTerm} />
            ))}
          </ul>
        </>
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
        <>
          <header className="kf-lib-sum">
            <span className="kf-lib-sum__count">{matched}</span>
            <span className="kf-lib-sum__kick">
              document{matched === 1 ? "" : "s"} match{matched === 1 ? "es" : ""} &ldquo;{trimmed}&rdquo;
            </span>
          </header>
          <ul className="kf-hit-list" aria-label={`${matched} matching documents`}>
            {results.map((d) => (
              <HitRow key={d.id} doc={d} firstTerm={firstTerm} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function HitRow({ doc, firstTerm }: { doc: IndexedDoc; firstTerm: string }) {
  const where = [doc.shelf, doc.kindLabel].filter(Boolean).join(" / ");
  const sentence = doc.summary || doc.card_line || null;
  const version = doc.version != null ? `v${doc.version}` : "";
  const date = (doc.updated_at || "").slice(0, 10);
  return (
    <li>
      <Link href={`/library/${doc.id}`} className="kf-hit" prefetch={false}>
        <div className="kf-hit__id">
          {doc.id}
          <span className="kf-hit__kind">{doc.kindLabel}</span>
        </div>
        <div>
          {where ? <div className="kf-hit__where">{where}</div> : null}
          <span className="kf-hit__title" title={doc.title}>
            {highlight(doc.title, firstTerm)}
          </span>
          {sentence ? (
            <span className="kf-hit__sentence">
              {highlight(sentence, firstTerm)}
            </span>
          ) : null}
        </div>
        <div className="kf-hit__meta">
          <div>{version}</div>
          <div>{date}</div>
        </div>
      </Link>
    </li>
  );
}
