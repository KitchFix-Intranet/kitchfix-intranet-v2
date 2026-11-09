# V2 Intranet - Ledger (living state)

RULE: this file is updated in the SAME PR as the train it describes. A PR that ships a
surface or changes state and does not update this file is incomplete. State moves with the
code that changed it - never in a separate pass, never from a chat's memory.

Canonical for STATE only. For design standards see docs/GOVERNANCE.md and the design master;
for values see docs/DESIGN.md and src/app/tokens.css.

## Production
- prod SHA: 9ab6640 (merged 2026-11-05) - `fix(stockpot m3): progress-based termination, state-based collision, page additions`
- served by Vercel deployment `dpl_7nmr1YdpTW4iA1YVX2emNw54VjKK` (target=production, state=READY)

## Shipped (merged to step-1, newest first)
Projection of `git log --first-parent --merges origin/step-1-shell-and-ingredients` - regenerate from git, do not hand-curate. Recent direct-to-step-1 commits (not via PR) are not merge trains and are not listed here; read them from git when needed.

- PR #16 (cb8ba14) feat(academy F3): Team + Admin lead with the answer
- PR #15 (c45c83f) fix(academy F1): topbar reads x-pathname first so routes resolve
- PR #14 (14a1ccb) feat(academy F2): Library finished against render V7
- PR #13 (47f4cf9) fix(academy F1): head-wash was flattening the band
- PR #12 (9681e8b) feat(academy F1): learner surfaces finished against render V7
- PR #11 (5b00b16) feat(academy E4): Team - leads' review page (read-only)
- PR #10 (760475c) feat(v2): release-controlled app-access gate (default CLOSED)
- PR #9 (74a31cb) feat(academy E3): Admin / People - roster + compliance + region leads
- branch merge (fc23cbe) potrack-row-flag-toggle
- PR #8 (d1433bf) feat(academy E1): Admin shell (owner-only) + Cycles (create / preview / publish / close)
- PR #7 (c71b679) feat(library D2): Find landing + Shelves moved + doc-reader TOC side-rail
- PR #6 (69f9edb) feat(library D1): shelves browse + read-only document viewer
- PR #5 (ccd910f) fix(academy): sign preview matches stored sentence (one source of truth)
- PR #4 (43a6916) fix(academy): multi-section attestation sentence + cert 503
- PR #3 (ec62cf1) Academy train C: reader + checks + sign + Receipt (the loop closes)
- PR #2 (f28d820) Academy train B: To do + Done + reader stub + Academy nav in shell
- PR #1 (1f1c1d0) Academy train A: engine port (lib + routes + parity harness + ACADEMY.md)

## In flight
- F4 - shared promotion: head wash + earned-column system move from academy.css into the shell (tokens.css/components.css). Was gated on the Stockpot lane vacating shared CSS; that lane is inactive, so re-confirm nothing is uncommitted there, then it can proceed.
- E2 - Questions (Academy): the content-authoring tool and the real launch gate. Prompt drafted; next Academy train.
- People Portal v2: starting. Blocked on (a) which Directory design is current, (b) four shell patches the dead Stockpot lane never landed - hand those to Kevin.

## Deploy rule
Auto-promote is OFF. Merges build as PREVIEW; Kevin promotes deliberately via the Vercel UI (the API 422s on preview builds); verify the prod alias SHA after each promote.
