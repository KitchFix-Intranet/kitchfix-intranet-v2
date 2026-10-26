# GOTCHAS

v2 twin of the intranet's `docs/GOTCHAS.md`. The twelve items below are the
canonical UI-build roster from `V2_CRAFT_BAR_SPEC_2026-10-25.md` section 10;
branch-specific items from Phase 1 live at the bottom. Add a new item
whenever a build-pass acceptance turns out to have a surprising root cause.

## 1. `display: initial` resets to `inline`, not the element's default

CSS `initial` goes back to the CSS initial value (`inline`), not the user-agent
default for the element. A `<section>` with `display: initial` becomes an
inline box and collapses background, min-height, sheen and padding - this was
the Home identity-band regression. Show hidden utility content with
`display: revert`; hide the other side with `display: none !important`. An
element carrying a utility class never sets its own `display`.

## 2. Every grid column is `minmax(0, 1fr)`, never bare `1fr`

A bare `1fr` grid column is `minmax(auto, 1fr)`: nowrap content widens the
column and pushes the grid off the canvas. The topbar title + crumb and
every data-health two-column layout use `minmax(0, 1fr)`.

## 3. `transition: width` never fires on grid-sized columns

A `transition: width` on an element whose width is set by its grid column
never fires - the width is a layout read-back, not a style property on the
element. Set the width on the element itself (the rail uses
`width: var(--rail-width)` and the shell grid is `auto | minmax(0, 1fr)`).

## 4. `toLocaleString()` on the server renders in UTC and the server locale

Server-side `toLocaleString()` runs in Vercel's TZ (UTC) and whatever locale
is default; dates come out off-day and English-US by accident. Format in one
place with an explicit timezone - `src/lib/fmt.ts` + Chicago.

## 5. A client count-up over a server number flashes final -> 0 -> final

A `<CountUp>` client component that animates from 0 to the server-rendered
value will flash the final value on first paint, then jump to 0, then
animate up. Render the value hidden until mount; set visible from the
client. The server-rendered element must carry the final formatted value so
JavaScript-off still shows a number.

## 6. CSS reveal replays on every client navigation

A `.kf-reveal` keyframe fires every time the component mounts, which on
App-Router pages is every soft nav. Gate it per route per session with a
sessionStorage key, and treat
`performance.getEntriesByType('navigation')[0].type === 'back_forward'` as
already-revealed.

## 7. Page CSS imports are bundled per-route, not globally

A class defined inside `home.css` exists only on routes that import
`home.css`. Next bundles CSS per-import. Shared primitives (`.kf-btn`,
`.kf-pill`, `.kf-card`, `.kf-state`, `.kf-empty`, `.kf-error`, `.kf-skel`,
`.kf-toast`, `.kf-kv`) live in `src/app/components.css`, imported from
`src/app/layout.tsx` right after `globals.css`.

## 8. `position: fixed` is relative to a transformed ancestor

A `position: fixed` element inside an ancestor with `transform` (or
`filter`, or `will-change: transform`) is positioned relative to the
ancestor, not the viewport. The notch toggle must not sit inside any
ancestor with a transform; the rail animates `width` only, not transform,
precisely because of this.

## 9. `role="tab"` on filter chips breaks screen readers

A screen reader hearing `role="tab"` expects a `role="tabpanel"` below with
`aria-controls` wiring. Segment chips on the Vendor items table are
`<button aria-pressed="true/false">` instead - a toggle group, not a tab
set.

## 10. A URL-param drawer cannot animate its exit from the server

The drawer is mounted when `?drawer=<id>` is in the URL and unmounted when
it is cleared, so a plain `<Link>` close navigates and the drawer is gone
before any exit keyframe can play. A `<DrawerFrame>` client wrapper plays
`kf-slide-out` + `kf-fade-out` first, then calls `router.push(closeHref)`.

## 11. Vercel: branch pushes land on preview; promote to see them in production

A `git push` to a non-production branch creates a Vercel preview deployment.
Production serves the branch set in Project Settings. Check the deployed
commit SHA before trusting a fix - the "production" the user is looking at
may be the previous commit.

## 12. PostgREST caps every response at `db-max-rows`

Supabase's default `db-max-rows` is 1,000 on this project. An unpaginated
`.select()` silently truncates. Three cases found so far: `intake.ts`
`pagedLines` with `pageSize = 5000` saw 1,000 and quit; the Ingredients
overview did its JS aggregation off the first 1,000 of 10,000+ items; a
vendor-lookup `.select()` could hit the cap once vendors exceed 1,000.
Paginate with `.range(from, from + pageSize - 1)` breaking on an empty
page, or move the aggregation into a Postgres view (see
`0004_potrack_overview_views.sql`).

## 13. A function prop from a Server Component to a Client Component throws at render, not at build

`next build` and `tsc` pass; the page dies with a minified React error
(e.g. #441) behind the error boundary. The RSC Flight payload cannot
serialize a function, so React throws when the client tries to receive
it. Client components own their formatters and handlers; server parents
pass only serializable props - ReactNode, strings, numbers, plain
objects / arrays, hrefs. Event handlers are created inside the client
component, not passed from the server. Verifying a data page means
loading it in a production build, never just compiling it. First case:
`<CountUp value={n} format={fmtCount} />` on Overview.tsx (server)
crashed `/stockpot/ingredients`; the fix was to drop the `format` prop
and have `CountUp` import `fmtCount` itself.

---

Branch-specific items we have already lived through on
`step-1-shell-and-ingredients`:

## G-A `pr_` tables need explicit grants to `service_role`

Default privileges fire asynchronously or not at all;
`0002_potrack_grants.sql` granted SELECT / INSERT / UPDATE to `service_role`
on every `pr_` table explicitly because the app reads AND writes through
the service-role client. Every new `pr_` table added by a later step must
carry the same grant block in its migration or every server-side read
returns 42501.

## G-B The dark-phase gate is a plain Next 404, not a 403

A signed-in session that is not in `OWNER_EMAILS` receives the Next
`not-found.tsx` page on every protected route - no 403, no branded landing,
no "forbidden" text. The owner check lives in `src/lib/gate.ts`
(`requireOwnerPage` calls `notFound()`); the proxy only handles session
refresh and the unauthenticated redirect.

## G-C `fiscal_periods` is add-only, service-role read only

The topbar reads one `fiscal_periods` row per uncached request to derive
the "Period N, week M" tag. The reads are memoized by Chicago date string
in a module-level Map inside the server bundle.

## G-D PDF logos convert cleanly with `pdftocairo -svg`

Illustrator "PDF (vector)" exports convert to small SVGs via Poppler
(`brew install poppler`). The round-coord + `fill-rule` / `fill-opacity`
scrub cuts output 30-40 percent and keeps the real alpha; do not use the
matching `.png` copies unless Poppler is unavailable.
