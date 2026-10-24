# KitchFix v2 - DESIGN

The design law. Kevin reviews every preview against two approved renders he holds; this file plus `src/app/tokens.css` is the written spec. Build from these, not from guesses. Any color or radius value in component CSS that is not a `--sp-` token is a defect. Light mode only. Hyphens, not em-dashes. No emojis. Plain words.

This file is the binding extract of the master Kevin holds. If something below reads ambiguous next to a render, the render wins and this doc gets updated in the same PR.

## 1. Signatures

- Global `h1`-`h4`: display face (`--sp-disp`), uppercase via CSS `text-transform`, `line-height: 1`, `letter-spacing: .2px`. Typed copy stays sentence case.
- Eyebrow: condensed 700, `--sp-t-label` (13px), `letter-spacing: 2px`, uppercase, color `--sp-red`, with a 56 by 5 red bar `skewX(-30deg)` sitting under it.
- Skew motif: `-30deg` red bars and `--sp-navy-mid` sheen panels on identity bands. Tags skew `-12deg`.
- Tabular numerals on every figure, globally (`font-variant-numeric: tabular-nums`).
- Light only; no dark mode. The site refuses the OS dark preference by setting `color-scheme: light` in `tokens.css`.

## 2. Chrome

Desktop and tablet (viewport wider than 860px).

- Rail: `--sp-rail` (236px), background `--sp-navy-deep`. Collapsible to `--sp-rail-slim` (76px) icon rail; state persists in `localStorage` with try/catch (private-mode browsers do not crash the app). Nav item 48px tall, radius `--sp-r-sm`, color `--sp-on-navy-text`. Hover: white at 7 percent. Active: `--sp-sky-tint` background, `--sp-navy` text.
- Two rail levels. Top level is Home plus the six tool doors. Entering a tool swaps the rail to that tool's pages with an "All tools" row at the top to climb back out.
- Topbar: white, sticky, `--sp-topbar` (64px), 1px `--sp-line` bottom border. Page title in `--sp-t-title` navy display face plus a short context line. Search / ask placeholder lives on the right.
- Compact identity band on Home and tool landings, roughly 130px, `--sp-navy-deep` with a `--sp-navy-mid` sheen panel at the skew motif. Not present on phones.
- Drawers open on the right at `min(480px, 100%)` width.

## 3. Phone (viewport 860px or less)

- Rail is off-canvas, revealed by a 48px hamburger in the topbar.
- Bottom tab bar: `--sp-tabbar` (64px), `--sp-navy-deep`, five slots. Active icon in `--sp-sky`.
  - At shell level: Home, Stockpot, People, Ops, Menu.
  - Inside Stockpot: Ingredients, Recipes, Menus, Signs, Menu.
- No identity band on phones.
- No page head that repeats the topbar title.
- Kick copy ("What is this?") lives behind a tap, not pinned above the content.
- Home on phones is a state feed, never a menu that duplicates the tab bar.
- Main content gets bottom padding equal to the tab bar height so the last row clears it.
- Cards are buttons - no full-width primary CTA inside a tappable card.
- Tables become stacked cards, or scroll inside their own card. Never the whole page.

## 4. Components

- Tiles. Radius `--sp-r-card`, shadow `--sp-shadow`. Label in condensed 700 at `--sp-t-label`, uppercase. Value in condensed 800 at `--sp-t-value` (34px). The lead tile on each screen uses the navy variant (background `--sp-navy`, text `--sp-on-navy`).
- Cards. `h3` 20px (`--sp-t-h3`). Clickable cards hover-lift: `translateY(-2px)` with `--sp-shadow-lift` and a 4px `--sp-navy` top reveal.
- Tables. Body `--sp-t-table` (14.5px). Headers 12.5px condensed 700 uppercase. Text left aligned, numbers right aligned with tabular numerals. Row hover `--sp-raise`.
- Buttons. Base 48px, radius `--sp-r-ctl`, filled navy for primary. Variants: line (1px `--sp-navy` on white), soft (`--sp-sky-tint` on white), ghost (text only). Small: 44px, radius `--sp-r-sm`. Rule: filled = action; outlined = status.
- Tabs. 48px tall, 3px `--sp-red` underline on a 2px `--sp-line` baseline.
- Status pills. One family, always paired with a word or shape so color is never the only signal.
- Toast. Background `--sp-ink`, white text, radius `--sp-r-ctl`. If reversible, carries a 44px inline Undo.
- Empty states. Mulish 17px 800 title plus one `--sp-muted` line. Framed as onboarding, not apology.
- Every data surface ships loading, empty, partial, and error states.

## 5. Floors

- Corp workbench surfaces: control floor 44px (`--sp-floor-corp`).
- Chef surfaces and all phones: control floor 48px (`--sp-floor-chef`), body text floor 16px (`--sp-t-body`).
- Named exception: the 50 by 30 toggle switch.

## 6. The battery

Every PR proves each item - with numbers, not adjectives.

1. Zero horizontal overflow at 1440 / 820 / 390.
2. Zero controls under the floor (44 corp, 48 chef).
3. `:focus-visible` present everywhere; on navy fills the ring is white.
4. Status is two-signal: color plus word or shape, plus a legend near the first instance.
5. No raw hex outside `tokens.css`. Grep output quoted in the PR body.
6. Tabular numerals on every figure.
7. Full click crawl: zero console errors.
8. Zero references to the previous culinary platform's name anywhere outside `docs/`.
9. Light-only under a dark-forced host (test in Chrome with the OS set to dark).
10. Phone: tab bar present, swaps on Stockpot entry, no title duplication, state-feed Home, no horizontal scroll on 390px.
11. Loading, empty, and error states present on every data surface.
12. The gate: a signed-in `kitchfix.com` session not in `OWNER_EMAILS` gets a plain 404 on every page and every route handler, including the CSV exports.

## 7. Scope carve-outs for step 1

- Pack parser arrives in step 3; `pack_state` reads `none` until then.
- Review queue and ingredient editing arrive in step 5; the tabs render but disabled with the step number on the hover.
- Price projections arrive in step 6.
- Day one the Overview will show 0 percent linked. That is correct and expected - no vendor item is linked to an ingredient yet.
