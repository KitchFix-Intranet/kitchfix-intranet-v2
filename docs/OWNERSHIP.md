# V2 Intranet - Lanes and ownership

Several Claude build sessions run against this repo and the step-1 branch at once. Ownership
keeps them from clobbering each other. A path has exactly one owning lane; other lanes read it
and hand Kevin a patch, they never edit it in their own PR.

## Shared foundation (the craft-bar / Stockpot lane owns these)
- src/app/tokens.css
- src/app/components.css  (shared components; lives in src/app/, not src/components/**/components.css as the template guessed)
- src/components/shell/Shell.tsx       (the shell chrome)
- src/components/shell/routeTitles.tsx (the topbar title + crumb map)
  - Shell lane owns the function, the types, the fallback, the Home entry, the order rules, and every other file in src/components/shell/.
  - Each section lane may ADD AND EDIT ONLY its own rows: People -> `/people...` rows; Academy + Library -> `/academy...` and `/library...` rows; Stockpot -> `/stockpot...` rows.
  - Row pattern, copied from the file:
    `{ test: (p) => p === "/stockpot/ingredients/vendor-items", v: { title: "Vendor items", crumb: "Stockpot / Ingredients" } },`
- src/lib/fmt.ts
- src/app/globals.css
- docs/DESIGN.md, docs/GOTCHAS.md
- public/brand/**

## Section lanes
- Academy + Library: src/app/(shell)/academy/**, src/app/(shell)/library/**,
  src/components/academy/**, src/components/library/**, src/lib/academy/**, docs/ACADEMY.md
- Stockpot / Ingredients: src/app/(shell)/stockpot/**, src/components/ingredients/**,
  src/lib/ingredients/**  (component dir is `ingredients/`, not `stockpot (potrack)/` as the template guessed)
- People Portal: src/app/(shell)/people/**, src/app/(shell)/@topbar/people/**,
  src/components/people/**, src/lib/people/**, src/app/api/people/**, docs/PEOPLE.md

## When a lane is inactive
Ownership does not evaporate. A needed edit to an inactive lane's files is handed to Kevin, who
applies it or assigns it to a live session. No build train waits on a dormant chat.

## Governance docs (the PM lane owns these; everyone else proposes a patch to Kevin)
- docs/GOVERNANCE.md, docs/LEDGER.md, docs/OWNERSHIP.md, docs/KICKOFF.md,
  and the design canon once it lands in docs/ (MANIFESTO, DESIGN_MASTER).
