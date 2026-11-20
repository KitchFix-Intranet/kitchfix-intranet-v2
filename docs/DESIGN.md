# KitchFix v2 - DESIGN

The design law. Kevin reviews every preview against two approved renders he holds; this file plus `src/app/tokens.css` is the written spec. Build from these, not from guesses. Any color, radius, duration or shadow in component CSS that is not a `--sp-` token is a defect. Light mode only. Hyphens, not em-dashes. No emojis. Plain words.

This file is the binding extract of the master Kevin holds. If something below reads ambiguous next to a render, the render wins and this doc gets updated in the same PR.

The approved render for Stockpot Ingredients V1 lives at `docs/renders/INGREDIENTS_V1_RENDER_REFERENCE.html` with its stylesheet `docs/renders/INGREDIENTS_V1_PROPOSAL.css`. Read both before touching any Ingredients surface.

## 1. Signatures

- A screen carries at most five type sizes. 12px (`--sp-t-micro`) is for dates, counts, and unit labels only - never for sentences. The weight and line-height tokens are `--sp-w-regular|semi|bold|heavy` and `--sp-lh-flat|tight|snug|body`; every new and touched rule uses them in place of raw 400/500/600/700/800 and raw 1/1.1/1.3/1.5.
- Global `h1`-`h4`: display face (`--sp-disp`), uppercase via CSS `text-transform`, `line-height: 1`, `letter-spacing: .2px`. Typed copy stays sentence case.
- Eyebrow: condensed 700, `--sp-t-label` (13px), `letter-spacing: 2px`, uppercase, color `--sp-red`, with a 56 by 5 red bar `skewX(-30deg)` sitting under it. The red bar lives only inside the identity band and on a `.kf-section-head`; card eyebrows use `.kf-eyebrow--plain` (same type, no bar).
- Skew motif: `-30deg` red bars and `--sp-navy-mid` sheen panels on identity bands. Tags skew `-12deg`.
- Tabular numerals on every figure, globally (`font-variant-numeric: tabular-nums`).
- Light only; no dark mode. The site refuses the OS dark preference by setting `color-scheme: light` in `tokens.css`.

## 2. Chrome

Desktop and tablet (viewport wider than 860px).

**Rail.** `--sp-rail` (236px), background `--sp-navy-deep`. Collapsible to `--sp-rail-slim` (76px); state persists in `localStorage` with try/catch (private-mode browsers do not crash the app). The width lives on the element itself (`width: var(--rail-width)`) so collapse animates over `--sp-base`. Shell grid is `grid-template-columns: auto minmax(0, 1fr)`.

- Notch toggle. A floating 28-px circle pinned to the rail's right edge (left = `calc(var(--rail-width) - 14px)`, top = `calc(var(--sp-topbar) / 2 - 14px)`), 28-px visual + 44-px hit area via a `::before` inset `-8px`, a chevron that rotates 180deg on collapse. Positioned off the rail because the rail's `overflow: hidden` would clip it. Must not sit inside anything carrying `transform`.
- Nav items: 48px tall, radius `--sp-r-sm`, color `--sp-on-navy-text`. Hover: white at 7 percent. Active: `--sp-sky-tint` background, `--sp-navy` text. Labels fade (`opacity`, `--sp-fast`) before layout collapses to the icon rail. In slim mode the live dot moves to a 6px bubble at the icon's top-right corner.
- Two rail levels. Top level is Home plus the six tool doors. Entering a tool swaps the rail to that tool's pages. Level 2 header is: a 44-px row with `ArrowLeft` + "All tools" (13px regular `--sp-on-navy-dim`, hairline below), then an uppercase section label (condensed 700, `--sp-t-micro`, 2px tracking, `--sp-on-navy-dim`), then the nav. Slim mode: back arrow only.
- Rail navigation is named. The outer `<aside>` carries `aria-label="Main navigation"`; the inner `<nav class="kf-rail__nav">` carries the current section: `Stockpot`, `People`, `Academy`, `Admin`, `Library`, or `All tools` at the top level. The active rail item carries `aria-current="page"`, as does the active slot in the phone tab bar.
- Skip link. The first keyboard stop in the shell is `Skip to the page` (`kf-btn kf-btn--primary kf-btn--sm kf-skiplink`), off screen until focused. Activating it moves focus to `<main id="main" tabIndex={-1}>`; the click handler cancels the default so `#main` never lands in the address. `.kf-canvas:focus` has no outline so no ring draws around the whole page when it receives focus.
- Account row. The rail foot carries a 56-px button: 32-px initials avatar on `--sp-navy-mid`, name (from `pr_users.name`, otherwise derived from the local-part on the server), role word under it (`Owner` / `Lead` / `Learner`) at `--sp-t-micro` dim, `ChevronDown` caret that rotates on open. The signed-in email does not cross to the browser - this screen does not need it and no other screen draws it into product chrome. Toggles a menu (`--sp-card`, `--sp-shadow-float`, `--sp-r-ctl`, 44-px items) with Sign out. Escape and outside click close it. Slim: avatar only; menu anchors right.

**Topbar.** White, sticky, `--sp-topbar` (64px), 1px `--sp-line` bottom border.

Anatomy:

| slot      | content                                                                 |
|-----------|-------------------------------------------------------------------------|
| title     | page title (`<h1>`, `--sp-t-title`, navy display). On phones the title never truncates; it stays at its intrinsic width and the crumb is what gives way. If the title alone cannot fit beside `actions`, only then does it ellipse |
| crumb     | short context line in `--sp-muted`; on Home carries long date + a `.kf-skew-tag` "Period N, week M" from `fiscal_periods`. On phones the crumb absorbs all row shrinkage, ellipses, and disappears before the title is ever touched |
| actions   | 1-2 controls from a parallel route slot (`src/app/(shell)/@topbar/<route>/page.tsx`), server-rendered - no portal, no context |
| progress  | 2-px `--sp-red` bar on the bottom edge; `.is-busy` scales X to 0.85 over 600 ms, completes to 1 and fades |

The pathname reaches the layout via an `x-pathname` header the proxy sets (Next does not expose `pathname` through `headers()` by default).

**Identity band.** `--sp-band` (128px), `--sp-navy-deep` with a `--sp-navy-mid` sheen panel at the skew motif. Grid `grid-template-columns: minmax(0, 1fr) auto`, padding `0 32px`.

Train 5a / D3 call 1 narrows where the band appears: **a tool's landing page carries the full band; a working tab's header is the top bar.** On a working tab the top-bar line carries the page title + crumb (as today) + a one-line fact set (`.kf-topfacts`, rendered from the tab's `@topbar` slot page via the shared cached loader) + the page's action if it has one. Overview keeps its band; Review queue, Ingredients, Retail and Vendor items drop theirs. The fact set hides at viewports <= 1100 wide (`@media (max-width: 1100px) { .kf-topfacts { display: none; } }`) so the title + crumb + action keep the single line at laptop widths.

- Left column: eyebrow, H2 (30px display, white, nowrap + ellipsis - a status headline built from data, never the page title, which the topbar owns; the only exception is the failure state below), kick (16px on-navy-text, nowrap + ellipsis, under 60 characters). Optional `kickInfo` button opens a popover below the band on click AND on focus, closes on Escape and outside click; never a hover-only title.
- Right column: facts (max 2) and the CTA. Fact label 12px condensed 700 2px tracking `--sp-on-navy-dim`, value `--sp-t-h1` (30px) condensed 800 white, note Mulish 12px 700 `--sp-good-on-navy`. 1px `--sp-navy-line` separators 44px tall, 28px gaps. CTA uses `.kf-btn--on-navy`.
- Failed state: facts render "Unavailable" with the note "Couldn't read intake status" and a `--line-on-navy` Retry (`router.refresh()`); the headline falls back to the page name.
- Running state: fact "Running" with a pulsing 10-px `--sp-sky` dot and the note "started {timeAgo} - about 3 min"; a `<RunningWatch>` client calls `router.refresh()` every 15 s. Stalled >= 15 min: "Stalled - started {timeAgo}" in warn tone.
- Compact desktop (viewport <= 1280px): the facts and their separators hide; the headline drops to `--sp-t-title`; the lead button and the failure-state Retry stay. A right column that holds no button is collapsed so the grid does not leave an empty track (`.kf-band__right:not(:has(.kf-band__cta)) { display: none; }`).
- Band section is `kf-only-desktop`; the section must not set `display` itself - the grid is on an inner div.

Drawers open on the right at `min(480px, 100%)` width. A URL-param drawer cannot animate its exit; the `<DrawerFrame>` client wrapper plays `kf-slide-out` + `kf-fade-out` before `router.push(closeHref)`.

## 3. Phone (viewport 860px or less)

- Rail is off-canvas, revealed by the Menu slot in the bottom tab bar. There is no hamburger in the top bar. 56-px topbar; topbar title is `--sp-t-h3` (20px).
- One way in: the drawer has exactly one opener on phones, the Menu slot (R-PP80, 2026-11-12).
- Rail close + "All tools" back row sit at `--sp-floor-chef` (48px) on a phone so both clear the chef floor.
- Bottom tab bar: `--sp-tabbar` (64px), `--sp-navy-deep`, five slots, label `--sp-t-micro` (12px). Active icon in `--sp-sky`.
  - At shell level: Home, Stockpot, People, Ops, Menu.
  - Inside Stockpot: Ingredients, Recipes, Menus, Signs, Menu.
- No identity band on phones. No page head that repeats the topbar title.
- Phone Home is a state feed, **never** a menu that duplicates the tab bar: date eyebrow + "Welcome back, {name}" + kick + two fact cards + a "More tools / On the current intranet" card listing the three tools the tab bar does not carry (Service Calendar, KPI Dashboard, Academy). **No doors on phone.**
- Kick copy ("What is this?") lives behind a tap, not pinned above the content.
- Main content gets bottom padding equal to the tab bar height so the last row clears it.
- Cards are buttons - no full-width primary CTA inside a tappable card.
- Tables become stacked cards, or scroll inside their own card. Never the whole page.

## 4. Components

- Tiles. Radius `--sp-r-card`, shadow `--sp-shadow`. Label in condensed 700 at `--sp-t-label`, uppercase. Value in condensed 800 at `--sp-t-value` (34px). The lead tile on each screen uses the navy variant (background `--sp-navy`, text `--sp-on-navy`).
- Cards. `h3` 20px (`--sp-t-h3`). Clickable cards hover-lift: `translateY(-2px)` with `--sp-shadow-lift` and a 4px `--sp-navy` top reveal.
- Tables. Rows 48px (`--sp-row`), `table-layout: fixed` with an explicit `<colgroup>`. Headers 12.5px condensed 700 uppercase, sticky (`position: sticky; top: 0`) inside the table card. Body `--sp-t-table` (14.5px). Text left aligned, numbers right aligned with tabular numerals. Row hover `--sp-raise`. Rows are **whole-row-clickable** through a `<RowLink>` client wrapper; the description cell is no longer a nested link. A legend bar lives between the meta line and the first row listing the link-state pills and the row flags.
- Buttons. Base 48px, radius `--sp-r-ctl`. Variants: `--primary` (navy fill), `--line` (1px navy on white), `--soft` (`--sp-sky-tint`), `--ghost` (text only), `--on-navy` (white on navy), `--line-on-navy` (transparent, white border 55 percent). Small 44px on a desktop, `--sp-floor-chef` (48px) at 860px and below so the phone floor holds. Rule: filled = action; outlined = status. Press: `translateY(1px)`. Busy: `.is-busy` spins the icon and disables pointer events.
- Tabs. 48px tall, 3px `--sp-red` underline on a 2px `--sp-line` baseline. Disabled tabs carry a `Lock size={14}` icon and `title="Arrives with ..."` - no visible step-number pill in the resting state.
- Status pills (one family). `.kf-pill--live / --info / --good / --warn / --block / --muted / --twin / --reserved / --premium`. Always paired with a word or shape so color is never the only signal. `.kf-pill--premium` is `--sp-sky-tint` on `--sp-navy` (10.06:1) - a grade is noteworthy, not a block; the earlier amber-register treatment (2.53:1) mis-read as a warning.
- Toast. `<Toaster>` mounted at the app root, `toast(message, { tone?, undo? })` from any client component. Background `--sp-ink`, white text, radius `--sp-r-ctl`, `--sp-shadow-float`. One toast at a time; a new toast replaces the one on screen at once. A toast with Undo stays 10 s and any other stays 6 s; hover and keyboard focus pause the clock, which carries on with the time that was left when both have gone. Every toast carries a 44-px X with `aria-label="Dismiss"`; a toast with Undo has Undo before the X. A failure toast (`tone: "block"`) is routed to an assertive live region (`role="alert"`); every other toast goes to a polite one (`role="status"`). Both regions sit in the document from first paint, so the first message is never missed. An undo that throws replaces its toast with `The undo did not finish. Check it before you go on.` and stops the clock while an undo is running.
- Empty states. `.kf-empty` with a 44-px `--sp-sky-tint` icon tile, Mulish `--sp-t-body` (16px) 800 title, one `--sp-muted` line. Framed as onboarding, not apology.
- Error states. `.kf-error` card with a `--sp-block` title at `--sp-t-body` (16px), a plain-English message, a Retry button. The raw `error.message` is never drawn to screen; the shell's `(shell)/error.tsx` keeps its `console.error` and shows a fixed sentence.
- Every data surface ships loading, empty, partial and error states.

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
13. Phone tab bar: every slot has `>= 48px` hit area and `aria-current="page"` on the active one.
14. Notch toggle: 28-px visual, 44-px hit, centered on `y = 32` at both rail widths; chevron rotated in slim.
15. Reveal plays once per route per session: `document.getAnimations()` after a soft-nav to a visited route is empty.
16. Toast: `<Toaster>` present at app root, reachable in a focus cycle; Undo button >= 44px.

## 7. Disabled surfaces (step 5 tabs)

Review queue and Ingredients-naming tabs render but disabled with a `Lock size={14}` icon and `title="Arrives with the review queue (step 5)"`. No visible step-number pill in the resting state - the `title` carries the detail on hover + focus. The tabs still land in the keyboard tab order but render `aria-disabled="true"`.

## 8. Elevation

- `--sp-shadow` for cards at rest.
- `--sp-shadow-lift` for the hover-lifted card and clickable rows.
- `--sp-shadow-float` for the notch, the account menu, and the toast.
- The drawer uses `--sp-shadow-lift` + its own `z-index: var(--sp-z-drawer)`.
- `z-index` ladder is `--sp-z-topbar: 10`, `--sp-z-notch: 30`, `--sp-z-rail-phone: 50`, `--sp-z-drawer: 60`, `--sp-z-toast: 90`. Any literal `z-index` outside tokens.css is a defect.

## 9. Motion

- `--sp-fast: 120ms`, `--sp-base: 200ms`, `--sp-slow: 320ms`, `--sp-rise: 480ms`, `--sp-stagger: 40ms`.
- `--sp-ease: cubic-bezier(.2,.8,.2,1)` for the exit side of most moves; `--sp-ease-io: cubic-bezier(.65,0,.35,1)` for symmetric slides.
- `.kf-reveal` fires once per route per session via `<RevealGate>`; browser back/forward counts as revealed. Items use `--i` and `--sp-stagger` for staggered delays.
- `<CountUp>` is hydration-safe: the server renders the final formatted value with inline `style={{ visibility: 'hidden' }}`; the client mounts, sets visible, animates from 0 to the value over 600ms with `tabular-nums`. Skips the animation when the value is 0, under reduced motion, or when `<RevealGate>` says the route already played. Never a frame that shows the final value, then 0.
- `@media (prefers-reduced-motion: reduce)` zeroes every motion token.

## 10. Loading and states

- 404 copy. The out-of-shell `not-found.tsx` reads `This page is not available` with the sentence `It may not exist, or your account may not have access to it.` and two ways out: `Go back` (only when there is a prior entry to go back to - a tiny client island reads `window.history.length`) and `Sign out` (the same POST the account menu uses). No logo, no tool names, no class from `components.css`: the gate answers "not found" to anyone outside the owner list on purpose. Its `<title>` is `Page not available`; `robots` stays noindex.
- `loading.tsx` renders inside the shell. The skeleton heights equal the content heights.
- Skeletons use the `.kf-skel` shimmer; `.kf-skel--navy` for a band placeholder; `.kf-skel--line` for text lines.
- Band `status` prop drives three paths: **ok** (facts), **failed** (facts render "Unavailable" with a Retry; the headline falls back to the page name), **running** (pulsing dot, 15-s auto-refresh via `<RunningWatch>`, "Stalled" fallback after 15 minutes).
- Empty surfaces use `.kf-empty` with a soft recovery action (Clear filters / Open vendor items / Reload). Error surfaces use `.kf-error` with Retry.

## 10.1 Browser-tab titles

- `<page> - <tool>`. Home is `Home - KitchFix`. A tool landing whose page name is the tool's own name (e.g. `/library`) is `<tool> - KitchFix`. A route with no row is `KitchFix`.
- First path segment maps to the product: `people` -> `People Portal`, `academy` -> `Academy`, `library` -> `Library`, `stockpot` -> `Stockpot`, `ops` -> `Ops Hub`, `service` -> `Service Calendar`, `kpi` -> `KPI Dashboard`.
- One source of truth lives in `src/components/shell/routeTitles.tsx`: `tabTitleFor(pathname)`. Rows may carry an optional `tabTitle` override; set it only on Stockpot rows where the browser-tab title differs from the top-bar title.
- Two writers share the resolver so both prongs produce the same string: `(shell)/layout.tsx`'s `generateMetadata` runs on every full load (and sets the title on first paint), and a `TabTitle` client island inside Shell re-writes `document.title` on every `usePathname` change (client nav + browser Back + Forward). A shared layout does not re-render on sibling nav, so the client writer is what survives client navigation.

## 11. Formatting and voice

- Dates and times go through `src/lib/fmt.ts` with `TZ = "America/Chicago"`. No `toLocaleString()` in components. Relative times are `<time dateTime={iso} title={fmtDate(iso, "time")}>`.
- Dollars and counts: `fmtUsd` (short, $462K / $1.82M / $9.84), `fmtUsdLong` ($40,475), `fmtCount` (`Intl.NumberFormat`). Statuses through `fmtStatus` ("ok" -> "Completed", "failed" -> "Failed", "running" -> "Running"). No raw enum value in the UI, ever.
- Copy is sentence case; uppercase comes from CSS. Hyphens, not em-dashes.
- Spanish headroom: every title and label is written short enough to carry a 30 percent longer Spanish translation without wrapping. Band headline, tile labels and tab labels get a `scrollWidth === clientWidth` check at 1280px.
- Tooltips never carry text that only a hover reveals - every tooltip either repeats a visible label (icon-only buttons: `title="Archive"`) or carries help text that is also available on focus (step-5 tabs: `title="Arrives with the review queue (step 5)"`).

## 12. Shared components file

- `src/app/components.css` carries every shared primitive: buttons, pills, cards, empty, error, skeleton, reveal, toast, kv.
- `src/app/globals.css` is base type + the two breakpoint utilities only.
- Page CSS files (`home.css`, `ingredients.css`, `table.css`, `drawer.css`, `signin.css`, `reserved.css`, `ident.css`) carry layout for one surface each.
- `src/components/ui/` holds the shared React primitives: `Toaster`, `RevealGate`, `Skeleton` (`Block` / `Line` / `Band`), `IdentBand`, `KickInfoButton`, `RunningWatch`, `BandRetryButton`.

## 13. Spacing and z-index scales

- Spacing: `--sp-sp-1: 4px`, `--sp-sp-2: 8px`, `--sp-sp-3: 12px`, `--sp-sp-4: 16px`, `--sp-sp-5: 24px`, `--sp-sp-6: 32px`, `--sp-sp-7: 40px`, `--sp-sp-8: 48px`. Component CSS uses the scale for gaps and padding; existing files are migrated to it as they are touched.
- z-index: `--sp-z-topbar: 10`, `--sp-z-notch: 30`, `--sp-z-rail-phone: 50`, `--sp-z-drawer: 60`, `--sp-z-toast: 90`, `--sp-z-skip: 100` (the skip link sits above every chrome layer, toasts included).
- Weights: `--sp-w-regular: 400`, `--sp-w-semi: 600`, `--sp-w-bold: 700`, `--sp-w-heavy: 800` (the four weights the font link loads; 500 is not loaded and draws as 400).
- Line heights: `--sp-lh-flat: 1`, `--sp-lh-tight: 1.1`, `--sp-lh-snug: 1.3`, `--sp-lh-body: 1.5`.

## 14. Gotchas

The twelve-item roster lives in `docs/GOTCHAS.md`. Add a new item there whenever a build-pass acceptance turns out to have a non-obvious cause. Items we have already lived through on `step-1-shell-and-ingredients` are listed under the branch-specific section at the end of that file.

## 15. Palette contrast rulings

Values live in `src/app/tokens.css`; this section carries the rulings that bind them.

- `--sp-muted: #5C6778` (R-PP63, 2026-11-11). Was `#6B7686`, which measured 4.26:1 on `--sp-sky-soft` and failed WCAG AA (needs 4.5). The new value is 5.29 on `--sp-sky-soft` and 5.73 on white.
- `--sp-line-field: #7F8B9A` (R-PP63, 2026-11-11). For form control borders only - do not point cards, tables or dividers at it. `--sp-line` is 1.29:1 on white (too faint for a form-control edge; needs 3). `--sp-line-field` is 3.46. People uses it in its own lane; a cross-lane adoption is a follow-up ruling, not an implicit retrofit.

---

## Scope carve-outs for step 1

- Pack parser arrives in step 3; `pack_state` reads `none` until then.
- Review queue and ingredient editing arrive in step 5; the tabs render but disabled per section 7.
- Price projections arrive in step 6.
- Day one the Overview will show 0 percent linked. That is correct and expected - no vendor item is linked to an ingredient yet.
