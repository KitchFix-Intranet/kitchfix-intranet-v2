// The small bit of state for the phone colour-key disclosure.
//
// Lives in its own file (and not inside PeriodStage.tsx) so
// PeriodStage can stay a server component. Server components cannot
// pass functions into client components; keeping the useState here
// means the only props crossing the boundary are serializable
// primitives.

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export function LegendDisclosure({ hasClosed }: { hasClosed: boolean }) {
  const [open, setOpen] = useState(false);
  const items: { key: string; word: string }[] = [
    { key: "sent",  word: "Submitted" },
    { key: "ent",   word: "Entered" },
    { key: "proj",  word: "Projected" },
    { key: "need",  word: "Needs actuals" },
    ...(hasClosed ? [{ key: "shut", word: "Closed" }] : []),
    { key: "none",  word: "No service" },
    { key: "today", word: "Today" },
  ];
  return (
    <>
      <ul className="kf-sc-legend kf-sc-only-wide" aria-label="Day colour key">
        {items.map((it) => (
          <li key={it.key}>
            <span className={`kf-sc-sq kf-sc-sq--key is-${it.key}`} aria-hidden />
            <span>{it.word}</span>
          </li>
        ))}
      </ul>
      <div className="kf-sc-legend-fold kf-sc-only-narrow">
        <button
          type="button"
          className="kf-sc-legend-fold__btn"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>What the colours mean</span>
          {open ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
        </button>
        {open ? (
          <ul className="kf-sc-legend" aria-label="Day colour key">
            {items.map((it) => (
              <li key={it.key}>
                <span className={`kf-sc-sq kf-sc-sq--key is-${it.key}`} aria-hidden />
                <span>{it.word}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
