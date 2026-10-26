"use client";

// Shelves browser. Server page hands over the LibraryBody shape (pure
// data). Left column is the shelf list; the right pane shows the
// documents on the active shelf. One client island because the shelf
// selection is interactive; the rows themselves are plain <Link>s.
//
// GOTCHA 13: this file carries "use client" so useState + onClick are
// legal. The server page (page.tsx) passes only data props.

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { LibraryBody } from "@/lib/academy/library";
import { humanizeDocClass } from "@/lib/academy/docClass";

type Props = {
  shelves: LibraryBody["shelves"];
};

export function ShelvesBrowser({ shelves }: Props) {
  const firstWithDocs = useMemo(() => shelves.findIndex((s) => s.docs.length > 0), [shelves]);
  const initial = firstWithDocs >= 0 ? firstWithDocs : 0;
  const [activeIdx, setActiveIdx] = useState<number>(initial);

  const active = shelves[activeIdx] ?? shelves[0];
  const trainsCount = active?.trains_you_count ?? 0;
  const totalCount = active?.count ?? 0;

  return (
    <div className="kf-library__grid">
      <nav className="kf-library__shelves" aria-label="Shelves">
        {shelves.map((s, i) => (
          <button
            key={s.name}
            type="button"
            className={`kf-library__shelf-btn${i === activeIdx ? " kf-library__shelf-btn--active" : ""}`}
            onClick={() => setActiveIdx(i)}
            aria-pressed={i === activeIdx}
          >
            <span>{s.name}</span>
            <span className="kf-library__shelf-count" aria-label={`${s.count} documents`}>
              {s.count}
            </span>
          </button>
        ))}
      </nav>

      <section className="kf-library__shelf-pane" aria-label={`Shelf: ${active?.name ?? ""}`}>
        <header className="kf-library__shelf-head">
          <h2 className="kf-library__shelf-name">{active?.name ?? ""}</h2>
          <p className="kf-library__shelf-sub">
            {totalCount} document{totalCount === 1 ? "" : "s"}
            {trainsCount > 0 ? ` - ${trainsCount} on your to-do list` : ""}
          </p>
        </header>
        <div className="kf-library__docs">
          {(active?.docs ?? []).map((d) => (
            <Link key={d.id} href={`/library/${d.id}`} className="kf-library__doc" prefetch={false}>
              <span className="kf-library__doc-class" aria-label={`Document class ${humanizeDocClass(d.doc_class)}`}>
                {humanizeDocClass(d.doc_class) || "Document"}
              </span>
              <span className="kf-library__doc-text">
                <span className="kf-library__doc-title">{d.title}</span>
                {d.card_line ? <span className="kf-library__doc-sub">{d.card_line}</span> : null}
              </span>
              <span className="kf-library__doc-flags">
                {d.trains_you ? (
                  <span className="kf-pill kf-pill--on-todo" title="On your to-do list">
                    On your to-do list
                  </span>
                ) : null}
                <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
              </span>
            </Link>
          ))}
          {(active?.docs ?? []).length === 0 ? (
            <p className="kf-library__shelf-sub">No documents on this shelf.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
