# V2 Intranet - Ledger (living state)

RULE: this file is updated in the SAME PR as the train it describes. A PR that ships a
surface or changes state and does not update this file is incomplete. State moves with the
code that changed it - never in a separate pass, never from a chat's memory.

Canonical for STATE only. For design standards see docs/GOVERNANCE.md and the design master;
for values see docs/DESIGN.md and src/app/tokens.css.

The Shipped section is current state per lane, not a commit log. Git is the history; this is
the summary. The seed below is the only bulk fill; each new train appends its own one-line
entry in its PR (the ledger-in-PR convention, see GOVERNANCE.md).

## Production
- prod SHA: 9ab6640 - `fix(stockpot m3): progress-based termination, state-based collision, page additions`
- Vercel deployment `dpl_7nmr1YdpTW4iA1YVX2emNw54VjKK`, target=production, state=READY

## Shipped (current state per lane)
- Academy + Library - engine, learner loop, Library, admin (Cycles / People / Team), release-controlled access gate, F1-F3. Live. (PRs #1-#16.)
- Stockpot / Ingredients - craft bar + Ingredients, then the Oct 30 - Nov 5 run: allergens (b1), grade model (g1-g3), pack recovery (p1-p2), vendor-reliability gate, queue throughput (q2), rescan loader (l1-l4), observation-countability (n0 series), through m-series to m3. Live.
- Shared foundation - tokens, components, shell, sign-in. Live.

## In flight
- F4 - shared promotion: head wash + earned-column system move from academy.css into the shell (tokens.css/components.css). Was gated on the Stockpot lane vacating shared CSS; that lane is inactive, so re-confirm nothing is uncommitted there, then it can proceed.
- E2 - Questions (Academy): the content-authoring tool and the real launch gate. Prompt drafted; next Academy train.
- People Portal v2: starting. Blocked on (a) which Directory design is current, (b) four shell patches the dead Stockpot lane never landed - hand those to Kevin.

## Deploy rule
Auto-promote is OFF. Merges build as PREVIEW; Kevin promotes deliberately via the Vercel UI (the API 422s on preview builds); verify the prod alias SHA after each promote.
