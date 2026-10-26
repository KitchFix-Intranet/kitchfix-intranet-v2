# GOTCHAS

v2 twin of the intranet's `docs/GOTCHAS.md`. Non-obvious causes behind defects
in this repo; add a new item whenever a build-pass acceptance turns out to
have a surprising root cause.

The first batch comes from `V2_CRAFT_BAR_SPEC_2026-10-25.md` section 10. That
spec file is not inside this repo yet; Kevin pastes it alongside the craft-bar
prompt but doesn't commit it. The items below are the known gotchas we have
already lived through on this branch; the twelve-item roster from spec
section 10 lands here as soon as the spec is checked in or quoted.

## G-1 - `.kf-only-*` utilities lose to any component display

`.kf-only-desktop` and `.kf-only-phone` are the only way to show or hide by
breakpoint. A component rule like `display: inline-flex` on a `.kf-topbar__burger`
beat the utility and leaked the hamburger onto desktop (commit `6c119c1`
investigation). Fix: `.kf-only-phone { display: none !important }` on the hide
side, `display: revert` on the show side, and the component sets its own
`display` only INSIDE the matching media query.

## G-2 - PostgREST ON CONFLICT does not accept a partial unique index

Supabase `.upsert({ onConflict })` emits `INSERT ... ON CONFLICT (cols) DO UPDATE`
with no `WHERE` predicate; Postgres cannot pick a partial unique index without
a matching predicate. The dedup fix (`0003_potrack_vendor_item_dedup_key.sql`)
replaced the two partial uniques on `pr_vendor_items` with a single stored
generated column (`dedup_key`) carrying `n:` / `d:` prefixes. Any new `pr_`
table that will be upserted gets a non-partial unique arbiter at creation
time; partial uniques are read-only indexes.

## G-3 - PostgREST responses are capped at `db-max-rows`

Supabase projects set a server-side maximum response size (1,000 on this
project). An unpaginated `.select()` silently truncates. Two cases found so
far: `intake.ts` `pagedLines` using `pageSize=5000` saw 1,000 and quit; the
Ingredients overview did its JS aggregation off the first 1,000 of 10,000+
vendor items. Fix: either paginate with `.range(from, from + pageSize - 1)`
breaking on an empty page, or move the aggregation into a Postgres view
(see `0004_potrack_overview_views.sql`).

## G-4 - the service_role needs explicit grants on new `pr_` tables

Default privileges fire asynchronously or not at all; `0002_potrack_grants.sql`
granted SELECT / INSERT / UPDATE to `service_role` on every `pr_` table
explicitly, because the app reads AND writes through the service-role client.
Every new `pr_` table added by a later step must carry the same grant block
in its migration or every server-side read returns 42501.

## G-5 - the dark-phase gate is a plain Next 404, not a 403

A signed-in session that is not in `OWNER_EMAILS` must receive the Next
`not-found.tsx` page on every protected route - no 403, no branded landing,
no "forbidden" text. The owner check lives in `src/lib/gate.ts`
(`requireOwnerPage` calls `notFound()`); the proxy only handles session
refresh and the unauthenticated redirect.

## G-6 - `display: initial` is NOT the element default

CSS `initial` resets to the CSS initial value (`inline`), not the user-agent
default for the element. A `<section>` with `display: initial` becomes an
inline box and collapses background, min-height and sheen. Use `display: block`
or `display: revert` (which goes back to the UA default).

## G-7 - never render raw enum values in JSX

Pack state, link status, status, food reason - all internal plumbing. The
drawer briefly rendered "yes (vendor_rule)" and "(none)" to the UI. Humanize
through `fmt.ts` helpers before the value crosses into JSX.

## G-8 - every grid column uses `minmax(0, 1fr)`

A bare `1fr` column lets nowrap content widen the column and push the grid
off the canvas. Topbar title + crumb row and all data-health two-column
layouts use `minmax(0, 1fr)`.

## G-9 - PDF logos convert cleanly with `pdftocairo -svg`

Illustrator "PDF (vector)" exports convert to small SVGs via Poppler
(`brew install poppler`). The round-coord + fill-rule / fill-opacity scrub
cuts output 30-40 percent and keeps the real alpha; do not use the matching
`.png` copies unless Poppler is unavailable.

## G-10 - fiscal_periods is add-only, service-role reads only

The topbar reads one `fiscal_periods` row per uncached request to derive the
"Period N, week M" tag. The reads are memoized by Chicago date string in a
module-level Map inside the server bundle; `use cache` would require
`cacheComponents` (changes the whole app's rendering model) and
`unstable_cache` is legacy.

## G-11 to G-12 - BLOCKED: pending the twelve-item roster from spec 10

The remaining items will land when Kevin pastes or commits
`V2_CRAFT_BAR_SPEC_2026-10-25.md` section 10. Flagged in the Phase 1 report.
