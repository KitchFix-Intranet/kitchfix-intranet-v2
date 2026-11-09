# V2 Intranet - Governance

## The chain of law (read in this order)
1. KITCHFIX_DESIGN_MANIFESTO.md - the constitution: who we are, the build loop, this chain.
2. The design master (STOCKPOT_DESIGN_MASTER.md) - Universe-2 design law: tokens, the two
   floors, the band, the 16-item battery, the craft standard, the mobile doctrine.
3. docs/DESIGN.md + src/app/tokens.css - the binding repo extract CC builds against.
4. docs/LEDGER.md - current cross-session state. docs/OWNERSHIP.md - the lane map.
5. A section's own master doc - its current design and rulings.

(The manifesto, the design master and the kickoff template are being moved into docs/ from the
claude.ai Project. Until they land here, read the Project copies. This file points at them
either way.)

## Disagreement - two kinds, two directions (do NOT collapse into "trust the code")
- FACTS AND VALUES - a token's value, a row count, what the DB holds, what shipped code does:
  the code and the database are canonical; the doc is stale and gets corrected.
- STANDARDS AND INTENT - how a thing should look or behave (floors, contrast, the battery, a
  design ruling): the rulebook is canonical; code that violates it is a DEFECT the battery
  catches, not a new standard. A too-small button that shipped does not lower the floor.
- Shorthand: the code tells us what is TRUE; the rulebook tells us what SHOULD BE true.
  Every gap is flagged P2 and logged, never silently reconciled.

## Promote global rulings (so decisions don't rot in one team's notes)
A ruling that changes a lever used by more than one section - a token, a floor, a chrome
element, or a cross-cutting rule (e.g. "an eyebrow is never red") - is copied into the design
master (and into tokens.css / docs/DESIGN.md when it is a value) in the SAME stroke. The
originating section's log keeps a one-line pointer. A global ruling that lives only in one
section's notes is drift waiting to happen.

## Ledger in the PR
State changes land in docs/LEDGER.md in the same PR as the code that changed them. See that
file's header. Reviewers (and CC acceptance) treat a missing ledger update as an incomplete PR.
