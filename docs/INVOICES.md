# Invoices V2 - lane doc

Train 1 shipped `/invoices/list` as owner-only + read-only. Capture,
Review, sending, Vendors and Bill.com integration arrive in later
trains.

## What this train ships

- `/invoices` -> redirects to `/invoices/list`, preserving `?as`.
- `/invoices/list` -> the list surface, owner-only. Address params:
  `site`, `show`, `q`, `inv`, `more`, `as`.
- `/invoices/[id]` -> resolves the id to its site inside the viewer's
  scope and redirects to `/invoices/list?site=<slug>&inv=<id>`. Unknown
  id, deleted / corrected / archived row, or a row outside the viewer's
  scope: `notFound()`. This is the address other tools (KPI) link to.

## The address map

| Address | Behaviour |
|---|---|
| `/invoices` | 302 -> `/invoices/list[?as=...]` |
| `/invoices/list` | Gated. Renders the surface, the drawer when `inv=<id>` is set. Bad `show` falls back to `all`. Bad / out-of-scope `site` -> 404. Bad `inv` -> list with no drawer. |
| `/invoices/[id]` | Gated. Scope check against `account_key`. Redirect or 404. |

## Who sees what (five-path scope rule)

Pure function in `src/lib/invoices/scope.ts`. Tested by `test:invoices`.

1. **Owner, not previewing** (`?as` absent): every site in scope. Train-1
   convenience for Kevin.
2. **Invoice reviewer** (`people.is_invoice_admin = true`): every site.
   In the UI this person is "the office" and the fix word reads
   "Sent back" everywhere "Needs a fix" would otherwise.
3. **Regional director** (`is_regional_director = true`): every site
   whose `accounts.region` equals the person's `region`. Both current
   RDs also carry `is_corp = true`; the rule tests RD BEFORE corp
   because otherwise every RD would be mis-classified as corporate
   and miss their region's sites.
4. **Salaried and tied to a site** (`is_salaried = true`, `account_key`
   is one of the in-scope sites): that one site.
5. **Anyone else**: no sites. The page renders the "no access" state
   (not a 404) so the owner can preview what they would see.

"A site" is an `accounts` row with `active = true` AND `team_key != 'CORP'`.
Today that is 11 sites (9 that carry invoices, 2 that do not). The site
select lists all 11; selecting a site with no invoices shows "Nothing
sent yet".

`resolveViewer` from the People lane does not select `is_invoice_admin`.
This lane reads it in `src/lib/invoices/load.ts :: isInvoiceAdmin()` with
one narrow query by `worker_id`, mirrored on `src/lib/sc/admin.ts`.

## Query budget

See the header of `src/lib/invoices/load.ts`. Three chip counts per
page load (All / Needs a fix / With accounting); a single returned-rows
read (bounded, 4 rows today); a paginated sent slice with exact count;
one rejections join; one people lookup for sender first names. The
drawer path adds four more queries (row by id, vendor flag, line count,
rejection) only when `inv=<id>` is present.

## Paging and ordering

- 50 rows per page via `.range(from, from + 49)`. The address carries
  `more=N` to mean "N pages have been loaded". `more=1` is the first page.
- Ordering: returned rows first, oldest-send-back first; then sent
  rows newest first (by `submitted_at`). Tie-break on `id`.
- No `.select()` ever requests more than 1,000 rows (Gotcha 12).

## Search safety

The lane never puts user text into `.or()`. PostgREST's `.or()` string
grammar treats `,`, `(`, `)`, `.` and quotes as structural, and supabase-js
does not escape them. Search runs two scoped queries - one `.ilike(vendor_name, ...)` and
one `.ilike(invoice_number, ...)` - with LIKE metachars (`%`, `_`, `\`)
pre-escaped via `src/lib/invoices/escape.ts`, then merges by id in app.
Chip counts in the search path follow the same discipline: two paginated
id walks per chip, union-dedup, size = chip count.

## Table vs cards - CSS container queries only

The list markup renders both the `<table>` and the stacked `<ul>` cards
on every request. A `container-type: inline-size` wrapper and two
`@container` queries decide which one is visible:

- One-site surface: table >= 1000 px, cards below.
- Many-site surface: table >= 1100 px, cards below.

The hidden side is `display: none` so it stays out of the tab order and
the accessibility tree. First paint at 390 and 1440 is already the
final layout; there is no JS layout chooser and no post-hydration shift.

## What this train does NOT do

- No writes of any kind. Grep: `.insert|.update|.upsert|.delete|.rpc|storage` -> zero hits.
- No Bill.com words. Grep: `Bill\.com|Paid|is next` -> hits are comments only.
- No email, no files, no uploads, no sending.
- No Rail entry, no top-bar title row for /invoices (the shared-
  foundation lane owns both; until that lands the top bar reads
  "KitchFix" on these pages).
- No "Fix it", "Withdraw", "Send back" or "Something is off" footer
  buttons in the drawer (Review arrives in train 3).
- No "No signal" state (belongs with typed work in Capture).

## Two lane-scoped CSS choices (pending the shared-foundation nod)

Both scoped under `.kf-invoices-surface` only:

1. Status pills at `--sp-t-label` (13 px). The shared `.kf-pill` is
   12 px (`--sp-t-micro`); the 13 px floor for a label on a site
   screen applies here.
2. Field edges (`input[type="search"]`, `select`) use `--sp-line-field`
   instead of `--sp-line`. Same discipline the People lane adopted in
   R-PP63; a cross-lane adoption is a separate ruling.

## Candidates for the shared lane (listed in the PR body)

- `src/lib/invoices/money.ts :: fmtUsdExact` as a candidate for
  `src/lib/fmt.ts` once a second lane needs exact cents.
- `src/components/invoices/OwnerPreviewBanner.tsx`: three copies in the
  repo now (service, people, invoices). Promote to `src/components/ui/`.
- The lane-local phone section head (`PhoneHead.tsx` markup): a candidate
  for a shared section head once a second lane needs the same pattern.

## Files touched inside the fence

- `src/app/(shell)/invoices/page.tsx`, `src/app/(shell)/invoices/list/{page,loading,error}.tsx`, `src/app/(shell)/invoices/[id]/page.tsx`
- `src/lib/invoices/{types,slug,scope,escape,money,accessList,firstName,load}.ts`
- `src/lib/invoices/__tests__/{slug,escape,money,scope,firstName}.test.mjs`
- `src/components/invoices/{InvoicesSurface,HeadBand,PhoneHead,Toolbar,InvoiceTable,StackedCards,Drawer,ShowOlder,RowOpen,StatusHelpDialog,OwnerPreviewBanner,EmptyStates,hrefs}.tsx`
- `src/components/invoices/invoices.css`
- `supabase/migrations/20261117170000_invoices_admin_flag_2026_11_17.sql` (record only; applied in Studio 2026-11-17)
- `docs/INVOICES.md` (this file), `docs/LEDGER.md` (one In-flight entry)
- `package.json`: one script line (`test:invoices`)

No file outside the fence was touched.
