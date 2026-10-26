# KitchFix v2 - DESIGN

The design law. Kevin reviews every preview against two approved renders he holds; this file plus `src/app/tokens.css` is the written spec. Build from these, not from guesses. Any color, radius, duration or shadow in component CSS that is not a `--sp-` token is a defect. Light mode only. Hyphens, not em-dashes. No emojis. Plain words.

This file is the binding extract of the master Kevin holds. If something below reads ambiguous next to a render, the render wins and this doc gets updated in the same PR.

## 1. Signatures

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
- Two rail levels. Top level is Home plus the six tool doors. Entering a tool swaps the rail to that tool's pages. Level 2 header is: a 44-px row with `ArrowLeft` + "All tools" (14.5px 600 `--sp-on-navy-text`, hairline below), then an uppercase section label (condensed 700, 12px, 2px tracking, `--sp-on-navy-dim`), then the nav. Slim mode: back arrow only.
- Account row. The rail foot carries a 56-px button: 32-px initials avatar on `--sp-navy-mid`, name (from `pr_users.name`, with the existing fallback), email 12px dim, `ChevronDown` caret that rotates on open. Toggles a menu (`--sp-card`, `--sp-shadow-float`, `--sp-r-ctl`, 44-px items) with Sign out. Escape and outside click close it. Slim: avatar only; menu anchors right.

**Topbar.** White, sticky, `--sp-topbar` (64px), 1px `--sp-line` bottom border.

Anatomy:

| slot      | content                                                                 |
|-----------|-------------------------------------------------------------------------|
| burger    | phone only, 48-px borderless                                            |
| title     | page title (`<h1>`, `--sp-t-title`, navy display)                       |
| crumb     | short context line in `--sp-muted`; on Home carries long date + a `.kf-skew-tag` "Period N, week M" from `fiscal_periods` |
| actions   | 1-2 controls from a parallel route slot (`src/app/(shell)/@topbar/<route>/page.tsx`), server-rendered - no portal, no context |
| progress  | 2-px `--sp-red` bar on the bottom edge; `.is-busy` scales X to 0.85 over 600 ms, completes to 1 and fades |

The pathname reaches the layout via an `x-pathname` header the proxy sets (Next does not expose `pathname` through `headers()` by default).

**Identity band.** `--sp-band` (128px), `--sp-navy-deep` with a `--sp-navy-mid` sheen panel at the skew motif. Grid `grid-template-columns: minmax(0, 1fr) auto`, padding `0 32px`.

- Left column: eyebrow, H2 (30px display, white, nowrap + ellipsis - a status headline built from data, never the page title, which the topbar owns; the only exception is the failure state below), kick (16px on-navy-text, nowrap + ellipsis, under 60 characters). Optional `kickInfo` button opens a popover below the band on click AND on focus, closes on Escape and outside click; never a hover-only title.
- Right column: facts (max 2) and the CTA. Fact label 12px condensed 700 2px tracking `--sp-on-navy-dim`, value 28px condensed 800 white, note Mulish 12px 700 `--sp-good-on-navy`. 1px `--sp-navy-line` separators 44px tall, 28px gaps. CTA uses `.kf-btn--on-navy`.
- Failed state: facts render "Unavailable" with the note "Couldn't read intake status" and a `--line-on-navy` Retry (`router.refresh()`); the headline falls back to the page name.
- Running state: fact "Running" with a pulsing 10-px `--sp-sky` dot and the note "started {timeAgo} - about 3 min"; a `<RunningWatch>` client calls `router.refresh()` every 15 s. Stalled >= 15 min: "Stalled - started {timeAgo}" in warn tone.
- Compact desktop (viewport <= 1280px): facts and separators hidden; headline drops to `--sp-t-title`; CTA stays.
- Band section is `kf-only-desktop`; the section must not set `display` itself - the grid is on an inner div.

Drawers open on the right at `min(480px, 100%)` width. A URL-param drawer cannot animate its exit; the `<DrawerFrame>` client wrapper plays `kf-slide-out` + `kf-fade-out` before `router.push(closeHref)`.

## 3. Phone (viewport 860px or less)

- Rail is off-canvas, revealed by a 48px borderless hamburger in the 56-px topbar; topbar title is 20px.
- Bottom tab bar: `--sp-tabbar` (64px), `--sp-navy-deep`, five slots. Active icon in `--sp-sky`.
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
- Buttons. Base 48px, radius `--sp-r-ctl`. Variants: `--primary` (navy fill), `--line` (1px navy on white), `--soft` (`--sp-sky-tint`), `--ghost` (text only), `--on-navy` (white on navy), `--line-on-navy` (transparent, white border 55 percent). Small 44px, radius `--sp-r-sm`. Rule: filled = action; outlined = status. Press: `translateY(1px)`. Busy: `.is-busy` spins the icon and disables pointer events.
- Tabs. 48px tall, 3px `--sp-red` underline on a 2px `--sp-line` baseline. Disabled tabs carry a `Lock size={14}` icon and `title="Arrives with ..."` - no visible step-number pill in the resting state.
- Status pills (one family). `.kf-pill--live / --info / --good / --warn / --block / --muted / --twin / --reserved`. Always paired with a word or shape so color is never the only signal.
- Toast. `<Toaster>` mounted at the app root, `toast(message, { undo })` from any client component. Background `--sp-ink`, white text, radius `--sp-r-ctl`, `--sp-shadow-float`. If reversible, carries a 44-px inline Undo. Auto-dismiss 6 s. The toaster container is `aria-live="polite"`.
- Empty states. `.kf-empty` with a 44-px `--sp-sky-tint` icon tile, Mulish 17px 800 title, one `--sp-muted` line. Framed as onboarding, not apology.
- Error states. `.kf-error` card with a `--sp-block` title, a plain-English message, a Retry button.
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

- `loading.tsx` renders inside the shell. The skeleton heights equal the content heights.
- Skeletons use the `.kf-skel` shimmer; `.kf-skel--navy` for a band placeholder; `.kf-skel--line` for text lines.
- Band `status` prop drives three paths: **ok** (facts), **failed** (facts render "Unavailable" with a Retry; the headline falls back to the page name), **running** (pulsing dot, 15-s auto-refresh via `<RunningWatch>`, "Stalled" fallback after 15 minutes).
- Empty surfaces use `.kf-empty` with a soft recovery action (Clear filters / Open vendor items / Reload). Error surfaces use `.kf-error` with Retry.

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
- z-index: `--sp-z-topbar: 10`, `--sp-z-notch: 30`, `--sp-z-rail-phone: 50`, `--sp-z-drawer: 60`, `--sp-z-toast: 90`.

## 14. Gotchas

The twelve-item roster lives in `docs/GOTCHAS.md`. Add a new item there whenever a build-pass acceptance turns out to have a non-obvious cause. Items we have already lived through on `step-1-shell-and-ingredients` are listed under the branch-specific section at the end of that file.

---

## Scope carve-outs for step 1

- Pack parser arrives in step 3; `pack_state` reads `none` until then.
- Review queue and ingredient editing arrive in step 5; the tabs render but disabled per section 7.
- Price projections arrive in step 6.
- Day one the Overview will show 0 percent linked. That is correct and expected - no vendor item is linked to an ingredient yet.
