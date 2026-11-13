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
  - M2 math (2026-11-13): PR against step-1 lifts the blend into `src/lib/ingredients/blend.ts` (one module; Premium-with-Premium on the blended lens); replaces `priceIn` with `priceInUnit` (what the case STATES wins; measures fill only what it does not; `case_weight_lb` replaces weight for one item). Sized packs no longer state count when the ingredient's measures bridge EA to the pack's uom. Count-costed ingredients whose sized packs still state count AND whose piece sizes disagree (max > 1.1 x min) flag `sizes_differ` before the outlier rule. `scripts/m2_blend_diff.mjs` carries the frozen d45d8db baseline + the new rules.
  - M2 screens (2026-11-13): three new ingredient-panel blocks and a new item-panel block replace the legacy UI. `PanelMeasuresBlock` owns the whole measures list + add form + rejectReason refusals + save-bar + dry-run; `PanelYieldRow` writes through `/api/review/set-ingredient-yield` (decimal-tolerant, 0 < pct <= 100, four-source enum); `PanelChipsRow` shows reach chips with dashed `add a measure` prefill for dashed uoms. `PanelIngredientZone` drops the `base_unit === "each"` gate; the new blocks render for every ingredient. `CaseWeightBlock` replaces `ItemEachMeasureBlock` on the item panel (behind the "This case is a different size" link at rest; open when stored); `HowWeGotTherePhrase` adds the plain-language route-to-price row. `attention.tsx` loses `unit_mismatch` and gains three M2 kinds: `needs_measure` (Add a measure, no Fix the pack), `check_it_outlier` (warn, no button), `sizes_differ` (Add a measure + Change Costed per, prefill 1 EA = largest-spend size). `PackOverrideBlock` verdict reaches via `priceInUnit` against the ingredient's measures (amendment 6). `ItemEachMeasureBlock` deleted. No screen reads `each_measure_*` any more. Shape helpers (`shapeIngredientEachFromMeasures`, `shapeItemEachFromCaseWeight`) uncalled by render-tree code; the file remains in `src/lib/ingredients/measuresShape.ts` for a future cleanup along with the legacy routes.
- Shared foundation - tokens, components, shell, sign-in. Live.
  - T0a (2026-11-11): People lane fence set in docs/OWNERSHIP.md; People rail wired in Shell.tsx; People titles + crumbs added to (shell)/layout.tsx; `--sp-muted` recolour and new `--sp-line-field` per R-PP63.
  - R-PP80 (2026-11-12): phone shell drops the top-bar burger; the bottom-bar Menu tab is the only drawer opener. The opener moves from first in the phone tab order to last (the bottom bar is DOM-last). Accepted trade, R-PP80. Files: `src/components/shell/Shell.tsx` (button at ~440-446), `src/components/shell/shell.css` (burger rule at ~376 and phone override at ~472).
  - Shell patch 2 (2026-11-12): phone topbar h1 no longer truncates. On phones the h1 gets `flex: 0 0 auto; max-width: 100 %` so the crumb is the shrinker (`flex: 1 1 0 %`) and ellipses first; the title only ellipses as the last resort when it alone cannot fit beside the actions. Desktop unchanged. File: `src/components/shell/shell.css` phone override at ~462.
  - Shell patch 3 (2026-11-12): top-bar title + crumb follow the route on client navigation. The title map moved out of `src/app/(shell)/layout.tsx` into `src/components/shell/routeTitles.tsx`. `src/components/shell/Shell.tsx` now calls `titleFor(usePathname(), dateLong, periodTag)` on every render; Shell's `title`/`crumb` props are removed in favour of `dateLong` + `periodTag`. Rows unchanged (29 before, 29 after). No change to `shell.css`, `tokens.css`, or `components.css`. Files: `src/app/(shell)/layout.tsx`, `src/components/shell/Shell.tsx`, `src/components/shell/routeTitles.tsx` (new), `docs/OWNERSHIP.md`, `docs/LEDGER.md`.

## In flight
- F4 - shared promotion: head wash + earned-column system move from academy.css into the shell (tokens.css/components.css). Was gated on the Stockpot lane vacating shared CSS; that lane is inactive, so re-confirm nothing is uncommitted there, then it can proceed.
- E2 - Questions (Academy): /academy/admin/questions ships. Author-grant gate (requireQuestionsAuthor, third tier) in src/lib/gate.ts; owners pass automatically, non-owners pass with grant_type='academy_questions_author' in academy_grants (Britt). Coverage view + editor island; lifecycle Save / Save as draft / Approve / Retire (no delete - service_role has no DELETE grant; retire is terminal). Learner path in module.ts is unchanged, still .eq('status','approved'); drafts + retired are invisible to learners (SQL-verified 8 -> 9 -> 8 across the draft/approve/retire cycle). Rail entry + title/crumb in Shell.tsx + (shell)/layout.tsx deferred - People Portal lane owns those files this week.
- People Portal v2: T2 (2026-11-12) - /people stops being the ReservedDoor and renders My team (owner-only, read-only); four scope rules server-enforced; person-card drawer with R-PP10 contact rule; ?as= owner preview. The four quick-action doors + the card's two buttons are inert. people_v2_01..04 migrations still only in Studio - repo copy is a follow-up.

## Deploy rule
Auto-promote is OFF. Merges build as PREVIEW; Kevin promotes deliberately via the Vercel UI (the API 422s on preview builds); verify the prod alias SHA after each promote.
