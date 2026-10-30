"use client";

// Document contents nav - scroll-spy island.
//
// Server renders the <nav> list fully (R-AC28: always open on
// desktop, never a <details> that hides children). The client wraps
// the server markup so the active section updates as the viewer
// scrolls the article, and a section click smooth-scrolls to the
// anchor without changing the hash. No <details> anywhere - that is
// the current P1 we are fixing.
//
// Props: the outline (headings parsed server-side) with the ids the
// server already injected into the article.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type OutlineItem = { level: number; text: string; anchor: string };

type Props = { outline: OutlineItem[] };

export function DocNav({ outline }: Props) {
  const [activeAnchor, setActiveAnchor] = useState<string | null>(
    outline[0]?.anchor ?? null,
  );
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Numbered counter for top-level sections (h1). H2/h3 keep "-" so
  // the number column only lights on section openers, matching V7.
  const numbered = useMemo(() => {
    let n = 0;
    return outline.map((o) => {
      if (o.level === 1) n += 1;
      return { ...o, n: o.level === 1 ? String(n).padStart(2, "0") : "" };
    });
  }, [outline]);

  // Scroll-spy. Observe every heading's anchor element in the
  // article and track the top-most one that is intersecting the
  // viewport. We use rootMargin to pin the "active" line near the
  // top (just under the topbar), so a mid-section scroll keeps the
  // right rail entry highlighted instead of flickering between two.
  useEffect(() => {
    const targets: HTMLElement[] = [];
    for (const o of outline) {
      const el = document.getElementById(o.anchor);
      if (el) targets.push(el);
    }
    if (targets.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        // Pick the highest intersecting target.
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0];
        if (top?.target) setActiveAnchor((top.target as HTMLElement).id);
      },
      {
        rootMargin: "-80px 0px -70% 0px",
        threshold: [0, 0.1, 0.5, 1],
      },
    );
    for (const t of targets) obs.observe(t);
    observerRef.current = obs;
    return () => obs.disconnect();
  }, [outline]);

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, anchor: string) => {
      const el = document.getElementById(anchor);
      if (!el) return;
      e.preventDefault();
      setActiveAnchor(anchor);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Keep the URL hash in sync without triggering the browser's
      // own jump - history.replaceState avoids the extra entry.
      try {
        window.history.replaceState(null, "", `#${anchor}`);
      } catch {
        // non-fatal
      }
    },
    [],
  );

  if (outline.length === 0) return null;

  return (
    <nav className="kf-docnav" aria-label="Contents">
      <div className="kf-docnav__head">
        <span>Contents</span>
        <span>{numbered.filter((o) => o.level === 1).length}</span>
      </div>
      <ul className="kf-docnav__list">
        {numbered.map((o) => (
          <li key={o.anchor}>
            <a
              href={`#${o.anchor}`}
              className={`kf-docnav__item kf-docnav__item--l${o.level}${activeAnchor === o.anchor ? " kf-docnav__item--active" : ""}`}
              onClick={(e) => onLinkClick(e, o.anchor)}
            >
              <span className="kf-docnav__n" aria-hidden>{o.n || ""}</span>
              <span>{o.text}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
