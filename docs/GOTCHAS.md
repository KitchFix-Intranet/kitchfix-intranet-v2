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

## 18. Column ownership: an upsert payload overwrites EVERY column it carries on an existing row

PostgREST `ON CONFLICT ... DO UPDATE` sets every column present in the
request body - no exceptions, no "only when null". Any column one
writer owns (defaults aside) must stay out of a second writer's
payload or that writer silently clobbers the first on every re-run.

Live case 2026-10-26: `intake.ts` carried `link_status: "none"` in the
`pr_vendor_items` upsert. Every intake run reset `link_status` from
`'proposed'` (matcher) and `'confirmed'` (human) back to `'none'`,
wiping the entire 538-item proposal queue and dropping confirmed
items out of coverage - a silent whole-queue destruction with no
error logged, because the upsert "succeeded". `ingredient_id`,
`link_reason`, `link_confidence` survived only because they weren't
in the payload at all; `link_status` was the one curation column
that slipped in.

Ownership for `pr_vendor_items`:

- Intake writes: identity + observed rollups (vendor, item number,
  description, pack text, dollars/lines, last_seen, catch_weight,
  is_food, status active/duplicate, dedup_key).
- Matcher + humans write: `link_status`, `ingredient_id`,
  `link_reason`, `link_confidence`.

Rules:

1. Drop any column the other writer owns from your upsert body.
   Rely on the column DEFAULT for a new row's starting value, never
   on an explicit payload field.
2. For every new multi-writer table, write down ownership in a
   comment at the upsert call site and in the migration header -
   both sides read it.
3. Verify a double-run before claiming "intake works": run it twice
   and prove that neither pass changes any curation column on an
   existing row. A clean build / clean grep is not enough.

## 19. A live region must be in the document before its message arrives

An `aria-live` region (`role="status"` / `role="alert"`) must exist in
the DOM at the first paint for screen readers to notice content
inserted into it. A Toaster that `return null` when no toast is on
screen adds the region and its first message at the same moment, and
some screen readers miss the announcement. Render the region (or
regions) on the server too, empty, and insert the message into an
already-mounted container. For tone-switched regions, use two
persistent siblings - one polite, one assertive - and route each
toast to the one that matches.

## 20. `await fetch()` with no try/catch freezes the control for good

A save handler that does `const res = await fetch(url, ...)` with no
try/catch will propagate a rejection (network dropped, timeout fired,
page unloading) past the awaiter. If the control's busy flag was set
before the await and the handler has no finally block, the busy flag
never clears - the button reads "Saving..." indefinitely and the
whole surface is stuck. The symptom looks like the server never
replied; the real cause is the exception. One shared path per lane:
`src/components/ingredients/panel/common.ts::postJson` never throws -
it returns `{ kind: "no-reply" | "server" | "refused" | "ok" }` and
the shared helper maps the kind to one of three plain sentences
beside the control. For long jobs (matcher, intake, backfills) pass
`timeoutMs: null` so the default 30 s cap does not fire.

## 21. PostgREST caps every `.select()` list at 1,000 rows, silently

A page that reads `from("pr_ingredients").select(...).eq("status","active")
.order("name")` without `.range()` gets at most 1,000 rows on this
project. Past that boundary the list just stops - no error, no note.
Four surfaces (`IngredientMasters`, `ReviewQueue`'s dropdowns,
`/api/review/ingredient`, `/api/review/item`) were each one ingredient
away from a silent short read. Fix: the shared paged reader at
`src/lib/ingredients/readIngredients.ts` runs a `count: "exact",
head: true` on the same filter, pages in 1,000-row windows, and
throws `IngredientListShortError` if the paged total does not match
the count. A page shows its error block; a picker says so in place
and offers nothing to pick. Proof: `scripts/t2_reader_proof.mjs`
stands in a 2,350-row fake and a page-drop variant.

## 22. A layout gate and a slot `default.tsx` both only run on a full page load

`(shell)/layout.tsx` calls `requireAppAccess(pathname)` with the pathname
of the **first full load**. On a soft nav to another route inside the
same shared layout, Next does not re-execute the layout, so its gate
does not re-run. If the layout is the only thing gating a protected
page, a role whose first full load lands on an opened path (e.g. Academy
with the release flag on) click-throughs into any other page that
depends on the same layout gate - including owner-only pages - with no
gate running at all. Rule: every page that reads data must call a gate
in its own `page.tsx` (first awaited thing, before any server component
is returned or any `redirect(...)`), the way `(shell)/page.tsx` and
`(shell)/people/page.tsx` already do. A layout gate is for shaping the
chrome the viewer sees, not for authorising the page.

The same asymmetry applies to the `@topbar` parallel slot: `default.tsx`
is only picked up on a full load. On a soft nav, Next keeps the slot's
previous page unless the new route matches a slot page, which is why
`Run intake` from `/stockpot/ingredients` used to linger on Home. Fix:
match every path to a slot page. One `@topbar/page.tsx` for `/` (a
catch-all does not match an empty segment list) + one
`@topbar/[...catchAll]/page.tsx` for every other unmatched path; both
return null. `default.tsx` stays for full-load behaviour. Next's route
precedence (static > dynamic > catch-all) keeps every existing named
slot page winning over the catch-all.

## 23. Two shapes of the same disposition during the correction window

Train 4 makes `one-off` and `not_food` first-class values of
`pr_vendor_items.status`, but the one-time correction that rewrites
old rows runs AFTER the deploy. During the window the database holds
BOTH shapes and every reader has to answer them the same way.

One-off:
  old: `status='archived', link_status='rejected', link_reason='oneoff:<email>'`
  new: `status='one_off',  link_status='rejected', link_reason='oneoff'`

Not food (person-marked):
  old: `status='active',   link_status='rejected', link_reason='notfood:<email>', is_food=true`
  new: `status='not_food', link_status='rejected', link_reason='notfood', is_food=true`

Readers must call `getVendorItemState` in
`src/lib/ingredients/vendorItemState.ts`; none of them inlines a
test on the raw columns. The segment filters on Vendor items widen
the Archived chip to `status in ('archived','one_off')` and the Not
food chip to `is_food=false OR status='not_food' OR (old-shape four-
column expression)` so no row hides. Overview totals come from SQL
views that test `status`; those views do NOT read the old shape.
Between deploy and correction, Overview keeps counting the 9 person-
marked not-food items as active food the way it does today; that is
accepted and not a bug to patch. After the correction runs, Overview
drops those 9 and coverage shares rise.

The reason-verb cleanup is live from this train on: new writes use
the verb only (`confirmed`, `split`, `relinked`, `archived`, `oneoff`,
`notfood`, `keep_separate`, `undo`). Old rows still carry their email
tails in the database; both `parseReason` functions drop everything
after the first colon so the UI never renders them.

## 24. A flex basis is a width in a row and a height in a column

`flex-basis` is interpreted along the flex container's MAIN axis.
In a flex row the main axis is width, so `flex: 1 1 280px` means
"start at 280 px wide, grow and shrink." In a flex column the main
axis is height, so the same declaration means "start at 280 px
tall." The shared `.kf-search` label originally shipped with
`flex: 1 1 280px` and sat happily in Review queue's row and
Vendor items' grid; on Ingredients and Retail its parent
`.kf-ingp__tools` is a column, so the 280 became a 280 px tall
label wrapping a 44 px input (236 px of empty air above and below).

Rule: a rule meant to size on the inline axis (width) uses
`width` / `max-width` / `min-width`. `flex-basis` only earns its
keep when the component is known to live in a row. Shared
primitives that may land in either shape stay off `flex-basis`
entirely. The chef-floor rule for `.kf-search` uses `max-width:
none` on phone so the search fills the row without a basis that
would double as a height.

## 25. A later rule of equal weight wins, so a media rule above the base it overrides does nothing

Two rules with the same specificity resolve by source order:
whichever appears later in the stylesheet wins. A
`@media (max-width: 1100px)` that overrides a plain
`.kf-foo { min-width: 1200px }` must sit AFTER the plain rule, not
before - put it above and the media rule is dead on every width.
Review queue hit this in train 5b round 2 (the stack rule at the
top of review.css never cleared the 1,200 px min below it, so the
card scrolled the page sideways at every window below 1,200) and
vendor items hit the same shape on Nov 16. When an `@media` or
`@container` rule "does nothing", the first check is "is it above
the base rule it overrides?".

A safer shape when the rules must live apart: put the base rule
first, then every width-conditioned override later in the file,
in ascending-specificity order. If a conditional has to go
earlier for reading flow, raise its specificity (one extra class
selector is enough) and leave a comment saying why.

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

## G-E Never read a SyntheticEvent inside a functional state updater

```tsx
// WRONG - crashes on second invocation in React 19 strict mode:
onChange={(e) =>
  setChecked((prev) => ({ ...prev, [id]: e.currentTarget.checked }))
}
```

React 19 strict mode double-invokes functional state updaters to surface
non-pure updates. SyntheticEvents are pooled / nulled right after the
handler returns, so the second invocation sees `e.currentTarget === null`
and `.checked` throws. This is the exact pattern that crashed the review
card on uncheck.

Capture the primitive first, then update:

```tsx
onChange={(e) => {
  const v = e.currentTarget.checked;
  setChecked((prev) => ({ ...prev, [id]: v }));
}}
```

Same rule for `e.target.value`, `e.key`, anything else sourced from the
event. If a handler needs multiple event fields, read them all into locals
on line 1.

## G-F `/api/admin/rescan-apply` can overwrite a person-set state

The absorbed-row UPDATE in `src/app/api/admin/rescan-apply/route.ts`
sets `status='duplicate', link_status='rejected',
link_reason='rescan_merge:absorbed'` with no state guard. It can
overwrite a `not_food` or `one_off` a reviewer set. Kevin's Nov 5
ruling ended the invoice re-scan and the tool is not run today; it
must gain a `status NOT IN ('not_food','one_off','archived')` guard
before it is ever run again.

## G-G Mail: sender domain, upload URI, Bcc, escaped key form

Four things to know about `src/lib/mail.ts :: sendSystemMail`:

1. The `sender` must be a mailbox in our own Google domain. The
   service account has domain-wide delegation for that domain
   only; the token's `sub` claim is `sender` and Google refuses
   any outside address. If a lane needs to send as an outside
   name, use `replyTo` and keep `sender` inside the domain.

2. The sender POSTs to the upload URI, not the JSON `raw`
   endpoint:
   `https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media`
   with `Content-Type: message/rfc822` and the RFC 5322 bytes
   directly. The alternative (`users.messages.send` with a
   base64url `raw` field in a JSON body) has been reported to
   fail above about 5 MB, which invoice PDFs can exceed. The
   upload path accepts up to the 25 MB cap enforced in
   `mailMessage.ts`.

3. `Bcc` is kept in the message handed to Gmail. Gmail strips
   it from the delivered copy but still honours the address.
   Nothing special is needed on the caller side; do not try to
   suppress the header.

4. `GOOGLE_PRIVATE_KEY` is read from the env as a string with
   literal `\n` sequences escaped as backslash-n (the shape the
   key export tool prints and Vercel stores). The sender does
   `raw.replace(/\\n/g, "\n")` before signing. A key stored with
   real newlines also works because the replace is a no-op.
