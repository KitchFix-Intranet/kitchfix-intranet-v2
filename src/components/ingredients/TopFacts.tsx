// Train 5a / D3 call 1: one-line fact set that sits in the top bar as
// the header on the four working tabs. Called from each tab's @topbar
// slot page after the slot's own loader resolves. When the slot has
// no facts to show (the frame hides the row at <= 1100 wide, or the
// loader is still resolving), the space is empty - no spinner.
//
// Shape: a plain row of <b>value</b> label chunks with hairline
// separators between them. Styling lives in src/app/components.css
// (.kf-topfacts family), ported from docs/renders/INGREDIENTS_V1_PROPOSAL.css
// part B.

import type { ReactNode } from "react";

export type TopFact = {
  // The bold number (or short word) the eye lands on first. Render-ready.
  value: ReactNode;
  // The light label that follows it, typed as one line of prose; this is
  // the full word (e.g. "groups to review"), not a key.
  label: ReactNode;
  // Warn tone recolours the value to --sp-warn. Used for the "need
  // attention" count on Ingredients (ruling 5).
  tone?: "ink" | "warn";
};

export function TopFacts({ facts }: { facts: readonly TopFact[] }) {
  if (facts.length === 0) return null;
  return (
    <span className="kf-topfacts">
      {facts.map((f, i) => (
        <span key={i}>
          {i > 0 ? <span className="kf-topfacts__sep" aria-hidden /> : null}
          <span className={f.tone === "warn" ? "kf-topfacts--warn" : undefined}>
            <b>{f.value}</b> {f.label}
          </span>
        </span>
      ))}
    </span>
  );
}
