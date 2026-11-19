# Invoices V2 - lane doc

Train 1 shipped `/invoices/list` as owner-only + read-only.
Train 2 ships **Capture**: the person adds files, each file becomes a
draft, they type the three fields, code it, and the tool checks it.
**Nothing is sent in train 2** - no row ever lands on
`invoice_submissions` and no email or Slack is fired. Review, sending,
Vendors and Bill.com integration arrive in later trains.

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
on every request. A `container-type: inline-size` wrapper and one
`@container` rule decide which is visible:

- Table shows at a container width of **940 px and up**, for both
  one-site and many-site surfaces. At a 1366 viewport with the rail
  open and a scrollbar showing, the container is about 959 px.
- Cards show below 940, including every phone width.

Column widths at the 940 threshold (fix pass 1, Chat-Claude ruling):

- Many-site: Site 100, Vendor fluid, Invoice 196, Sent 150, Total 116, Status 172.
- One-site: Vendor fluid, Invoice 196, Invoice date 112, Sent 104, Total 116, Status 172.

Status and Total never clip. Invoice numbers beyond what 196 px holds
ellipsis with the full value in the cell's `title` and in the drawer.
Vendor names ellipsis with the full value in the vendor button's
`title` and in the drawer header.

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
2. Control edges (`input[type="search"]`, `select`, filter chips,
   the "?" button) use `--sp-line-field` (3.46:1 on page ground)
   instead of `--sp-line` (1.18:1). Same token the People lane
   adopted in R-PP63 for form controls; extended in fix pass 1 to
   chip and toggle edges so every control in the lane clears the
   3:1 floor. A cross-lane adoption is a separate ruling.

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

## Train 2: Capture

### Addresses

| Address | Behaviour |
|---|---|
| `/invoices` | **Capture** (replaces train 1's redirect). No `site` on a one-site viewer -> redirect to that site. No `site` on a many-site viewer -> "Which site?". No sites in scope -> NoAccess. |
| `/invoices?site=<slug>` | Landing: drop zone + Latest sent + Drafts waiting. |
| `/invoices?site=<slug>&draft=<id>` | Sitting: the one draft open on it, page beside the fields on desk, stacked on phone. |
| `/invoices/list`, `/invoices/[id]` | Train 1 unchanged, except the list's band gains an "Add invoices" CTA for site + regional viewers when nothing needs a fix. |
| `/api/invoices/drafts` POST, GET | create / list drafts |
| `/api/invoices/drafts/[id]` PATCH | typing-save with If-Match |
| `/api/invoices/drafts/[id]/discard` POST | status='discarded' + discarded_at |
| `/api/invoices/drafts/[id]/undo` POST | clears both |
| `/api/invoices/drafts/[id]/check` POST | Ready check - no DB write |
| `/api/invoices/uploads` POST | signed upload URL (server builds the path) |
| `/api/invoices/files` POST | finish upload: magic bytes, size, SHA-256, page count, row insert |
| `/api/invoices/files/[id]` PATCH | rotation, sort_order |
| `/api/invoices/files/[id]/remove` POST | removed_at (no DELETE) |
| `/api/invoices/files/[id]/view` GET | 60-second signed URL |
| `/api/invoices/vendors` GET | picker payload, two scoped `.ilike` queries (name + alias_normalized) merged |
| `/api/invoices/gl-codes` GET | site's active codes + vendor's usual codes + 9-in-10 fill |
| `/api/invoices/latest-sent` GET | the five newest counting rows for the site |

### Upload flow (direct-to-bucket, server never sees the file body)

1. Browser mints a draft id (uuid) and posts to `/api/invoices/drafts`.
2. Browser posts to `/api/invoices/uploads` with the draft id, file name, size and MIME hint. Server pre-checks size + ext, mints a file id and builds the storage path, returns a signed upload URL.
3. Browser `PUT`s the file bytes to the signed URL (bucket).
4. Browser posts to `/api/invoices/files` with the draft id + file id. Server downloads the stored bytes, runs the magic-byte check (PDF/JPEG/PNG/WebP; HEIC refused with plain words), SHA-256s the bytes, counts PDF pages via `pdf-lib` with an 8-second cap, and inserts the `invoice_files` row. On any failure, the server removes the stored object.

**Server builds every storage path** (correction 5 of the train 2 prompt). The client never sends a path. The view route also builds its own path from the DB row.

### Idempotency (correction 3, gotcha 18)

- `invoice_drafts.id` is browser-generated; a repeat POST with the same id returns the existing row if the owner matches, 404 if not.
- `invoice_files.storage_path` is UNIQUE; a repeat finish on the same path fails with 23505 and the client treats it as "existing".
- Never `.upsert` on either table.

### No DELETE on either table

Verified by `grep '.delete(' src/lib/invoices src/app/api/invoices` - zero hits. Discard is `status='discarded'`; remove-file is `removed_at`. Both are reversible.

### Owner preview is look-only

Every write route gates on `viewer.previewOf !== null` -> 403 `preview_no_write`. The guard is in one place (`src/lib/invoices/apiGuard.ts`) so no route can forget it.

### Email discipline

- `owner_email` and `uploaded_by` never leave the server. `toDraftView` / `toFileView` strip them before every client response. Grep of the loader output for `@` on a real owner scope: zero hits.
- The three storage-path segments are `drafts/<draft_id>/<file_id>.<ext>`. No email, no site name, no vendor name in the path.

### Local-copy rule (correction 7)

- One flag per draft in `localStorage` (`kf.invoices.draft.<id>.dirty`). No device clock vs server clock comparison.
- On mount: if the flag is set, flush the saved patch; otherwise server wins.
- On a successful PATCH: flag cleared and the merged patch removed.

### Save queue (correction 8)

- One PATCH in flight per draft per tab. New field changes merge into a staged patch while a save is in flight; the next save carries the fresh `updated_at` the server just returned.
- If-Match uses the exact `updated_at` string the DB returned; a 409 triggers a page reload so the client restarts from the newer state.
- Two tabs on the same draft: the later save wins; the older tab reloads.

### Vendor picker

- Reads only `vendor_id, account_key, active` from `vendor_accounts` (never selects `portal_*`, `customer_account_num`, `sales_rep_*`).
- Searches by `vendors.name` and by `vendor_aliases.alias_normalized` in two scoped `.ilike` queries merged by id. Site vendors first.
- Deleted vendors are not offered.
- No vendor-creation path; one line tells the reader that Vendors is a later train.

### "Usual codes" and the 9-in-10 fill rule

- Loads the last 10 counting invoices for this (site, vendor); computes `codes` (distinct codes seen) and `singleCodeFill` (one single code that took the whole amount on at least 9 of the 10, with gl_breakdown length exactly 1 and the amount equal to the total to the cent).
- Fewer than 10 counting invoices -> no fill.
- Multiple codes equally dominant -> no fill.
- Typing the total with `singleCodeFill` set fills that one code in; the user may still change it with one tap.

### Ready is derived

The "Ready" label is never written to the database. `/api/invoices/drafts/[id]/check` returns `{ ready, errors }` and the UI uses it. Train 3 will take this payload as input to Send.

### pdfjs-dist

- One added dependency, exact-pinned (`6.5.438`).
- Loaded lazily and client-only via `dynamic(() => import("./PdfPage"), { ssr: false })`.
- Worker served **same-origin** via `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()` (no CDN).
- `/invoices/list` import graph does not reach `pdfjs-dist` (grep-verified). First-load size of `/invoices/list` is unchanged.

### Known gap (train 2 prompt correction 13)

An upload slot that is finished leaves an `invoice_files` row + a storage object. An upload slot where the browser receives the signed URL and then never PUTs leaves nothing. **But**: an upload slot that the browser PUTs to the bucket and then never calls `/api/invoices/files` on leaves a bucket object with no row. Train 2 does not clean those up. Documented; not solved in train 2.

### Why page-count can be null (correction 6)

`pdf-lib` can fail to open a PDF that is locked or has a damaged trailer. If the first bytes say PDF and the real kind check passes, the file is kept with `page_count = null`. The finish route runs `pdfPageCount` with an 8-second cap so a pathological file cannot stall. Largest PDF tested in `pdfPages.test.mjs`: 50 blank pages generated with `pdf-lib`.

### Files touched for train 2

- `src/app/(shell)/invoices/page.tsx` - replaced (was train 1's redirect to the list; now the Capture surface composer).
- `src/app/api/invoices/**` - 13 new route files (see address table).
- `src/lib/invoices/` - added `apiGuard.ts`, `draftLoad.ts`, `draftWrite.ts`, `dateInput.ts`, `moneyInput.ts`, `addUp.ts`, `usualCodes.ts`, `readyCheck.ts`, `duplicateCheck.ts`, `invNumber.ts`, `vendorPicker.ts`, `glCodes.ts`, `latestSent.ts`, `fileKind.ts`, `fileSha.ts`, `pdfPages.ts`. `types.ts` extended with `DraftRow` / `DraftView` / `FileRow` / `FileView` / `CheckResult`.
- `src/lib/invoices/__tests__/` - added `invNumber`, `dateInput`, `moneyInput`, `addUp`, `usualCodes`, `readyCheck`, `fileKind`, `duplicateCheck`, `pdfPages`.
- `src/components/invoices/` - added `CaptureLanding.tsx`, `WhichSiteChooser.tsx`, `CaptureSittingRoot.tsx`, `DropZone.tsx`, `PdfPage.tsx`, `VendorPicker.tsx`, `capture.css`. Modified `HeadBand.tsx` + `InvoicesSurface.tsx` to add the "Add invoices" CTA to the list's band.
- `supabase/migrations/20261117211626_invoices_t2_drafts_files_2026_11_17.sql` (record only; applied 2026-11-17 by Chat-Claude).
- `package.json` + lockfile - `pdfjs-dist` added.
