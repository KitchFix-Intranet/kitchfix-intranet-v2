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

## 13. The RSC boundary throws at render, not at build - and the rule covers inline helpers in server files too

`next build` and `tsc` pass; the page dies with a minified React error
(e.g. #441) behind the error boundary. The RSC Flight payload cannot
serialize a function, so React throws when the client tries to receive
it. Three shapes of the same crash:

1. **Function prop from a Server Component to a Client Component.**
   `<CountUp value={n} format={fmtCount} />` on `Overview.tsx` (server)
   handed `format` to a `"use client"` component. Fix: the client
   component owns its formatter (imports `fmtCount` itself); the prop
   is removed.
2. **Event handler inside an inline helper defined in a server file.**
   `SortSelect` was a plain `function` declared inside
   `VendorItemsPage.tsx` (server) rendering `<select onChange={...}>`.
   React threw at render. Fix: extract the helper to its own file
   starting with `"use client";` and import it. Marking only the
   top-level file `"use client"` is not enough; the rule applies to
   every function that renders JSX inside a server module.
3. **A hook inside an inline helper in a server file.** Same shape;
   `useState` / `useEffect` / `useRef` are client-only. If an inline
   sub-component uses hooks or browser APIs, extract it.
4. **A Server Component importing and calling a plain function or
   const from a `"use client"` module.** A Server Component may
   RENDER a component exported from a `"use client"` file as JSX,
   but it may never IMPORT and CALL a non-component value from one -
   Vercel surfaces this as `"Attempted to call parseSort() from the
   server but parseSort is on the client. It's not possible to invoke
   a client function from the server, it can only be rendered as a
   Component or passed to props of a Client Component."` The fix is
   to put the shared parser / constants / types in a plain module
   (no `"use client"`) that both the server page and the client
   component import; only the component itself carries `"use client"`.
   First case: `parseSort` + `SortKey` + `SORT_LABELS` moved to
   `./sortKeys` alongside the client `./SortSelect`. Also, when a
   client module exports a type, import it with explicit `type`
   syntax (`import { Component, type SomeType } from "./client"`) so
   TypeScript erases it at runtime instead of leaving a value
   reference.

Verify server->client render errors from **Vercel runtime logs** (the
real `error/function` message), not the minified client `#441`.

Verification cannot stop at `next build`. Both prior crashes compiled
clean. The sweep is:

- `grep -rnE "on[A-Z][a-zA-Z]+=" src/components src/app` and confirm
  every hit's enclosing file carries `"use client"` at line 1.
- `grep -rnE "(format|render|children|on[A-Z][a-zA-Z]+)=\{" src` and
  confirm no function value crosses from a server parent.
- For every server file, audit inline helpers for `useState` /
  `useEffect` / `useRef` / `window` / `document` / `on[A-Z]` handlers.
- Load the page in a production build (`next build && next start`), or
  on the Vercel preview; "compiles" is not acceptance.

Client components own their formatters, handlers and hooks; server
parents pass only serializable props (ReactNode, strings, numbers,
plain objects / arrays, hrefs).

## 14. A block element inside a `<p>` surfaces as React #418 hydration mismatch, not a build error

HTML forbids a block element inside `<p>`. The server emits the
`<div>` inside the `<p>`; the browser auto-closes the `<p>` before
the `<div>` opens; server and client DOMs disagree; React logs #418.
Easy to introduce by dropping an interactive component into a text
element typed as `<p>` - e.g. `<p>text <KickInfoButton>...</KickInfoButton></p>`
where `KickInfoButton` renders its own `<div className="kf-kickinfo">`
root. The band's kick row carried this exact bug on
`/stockpot/ingredients` after Phase 3.

Rule: `<p>` is for pure phrasing content (text + inline elements
only); use `<div>` for any row that may contain a component. Verify
hydration warnings from the un-minified `next dev` console or the
Vercel runtime logs, not from the minified client `#418`.

## 15. Supabase SSR cold-load 404: forward refreshed cookies onto the request, not just the response

`getUser()` inside the proxy rotates the refresh token and writes new
cookies. If those cookies are set only on the response, each
downstream server-component `getUser()` reads the still-stale request
cookies and retries a refresh with the already-rotated refresh token;
Supabase refuses it, the session reads empty, and
`requireOwnerPage()` calls `notFound()` - a spurious 404 that only
appears once the access token has expired (a cold load). Fix:
re-create `NextResponse.next({ request: { headers } })` inside the
`setAll` callback with the refreshed cookies written back onto the
request too, per Supabase's canonical `updateSession` pattern.
Never reproduces on a warm load; verify across a token-expiry
boundary.

## 16. Slim nav: `opacity: 0` is not out of flow

A label hidden with only `opacity: 0` still occupies its flex space,
so "center the icon" centers icon-plus-hidden-label and the icon
drifts left; anything pinned to the item's right edge (a status dot,
a badge) detaches from the icon. Collapse the label's `width` and
`flex` to zero (or `display: none`) and zero the item's `gap` so the
icon truly centers, then pin the dot to the icon's own corner, not
the item's.

## 17. `documents.status` is title-case; lowercase matches return zero rows silently

Postgres text equality is case-sensitive. `documents.status` stores
`Live`, `In Build`, `Pending`, `Retired`, `Blocked`, `Placeholder` in
title-case. `.eq("status", "live")` returns zero rows with no error -
the Library would show an empty catalog and the surface fails open as
"nothing here" rather than loudly. Use `.eq("status", "Live")` and
keep the capitalisation in every filter + fixture. Same discipline
for every title-cased enum column added later.

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
