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

## Train 2b: the Capture screen, as approved

Train 2b takes Capture from the first-cut screen train 2a left behind
to the screen Kevin and Chat-Claude approved. **Nothing is sent and
nothing lands on `invoice_submissions` in this train** - the fence and
the no-writes list from train 2 still hold. No new dependency, no new
migration, no package.json change.

### Section-6 pieces

- **A1/A2/A3 "Which site?"** - `WhichSiteChooser.tsx` renders the
  shared `IdentBand` on desk and a plain phone head (red tick) at
  860 px and under. Each site row shows a draft count when there is
  one. The kick is 48 characters: `"Pick one. It stays with every
  invoice you add."` (correction 10).
- **B1 landing headline** - server-computed: when a viewer has
  drafts, `"{ready} ready, {rest} still to finish"`; else
  `"Add this week's invoices"`. Readiness is `runReadyCheck`'s
  output, not a client-side copy of the rule (correction 6).
- **B2 needs-fix note** - `latestSent.ts :: loadReturnedForSite`
  returns the returned invoices for this site in oldest-first order;
  each becomes `"{vendor} #{number} was sent back."` + a quiet
  `"See it"` link. No `"Fix it"` button (the prompt overrides the
  render here).
- **B3 landing grid** - `.kf-inv-capture` carries `container-type:
  inline-size`; at a content width of 980 px the drop zone sits
  beside Latest sent. Below that, they stack.
- **B4 drop zone** - `DropZone.tsx` reads two screens worth of
  wording: desk `"Drop the vendor's copy or a clean scan here.
  Several at once is fine."`, phone `"The vendor's emailed copy
  or a clean scan."` with a singular `"Choose a file"`. The second
  "Add invoices" heading the render carries is dropped so the phrase
  appears once on the page.
- **B5 Latest sent** - five rows (both desk and phone; correction
  11 overrides the render's three on phone), 48 px each, token
  type. A quiet `"See all"` link under the list.
- **B6 Drafts waiting** - `DraftsWaitingList.tsx` (client). Each
  row: vendor name or `"No vendor yet"`, invoice number or
  `"No number"`, a short status (`"Ready"` / `"Vendor, Date left"`),
  `timeAgo(updated_at)`. Remove discards immediately and raises
  an Undo toast through the shared `Toaster`. No `confirm()`.
- **B7 upload tray** - four states (`"Uploading"`, `"Checking"`,
  `"Added"`, a failure line). Failed rows get a `"Try again"`
  button that re-runs the same `File` object.
- **B8 refused file reasons** - `"Over 50 MB"`, HEIC = `"Save it
  as a PDF or a JPEG and add it again."`, `"Not a PDF or a
  picture."` Same copy on both the pre-signing and the finish
  side.
- **B9 same-file-twice** - the finish route returns `dupe_of`
  when another of this viewer's drafts already holds a file with
  the same SHA. The row is kept; the lane `Sheet` opens with
  `"You already added this file"` and two choices: `"Remove this
  one"` and `"Use it anyway"`.
- **B10 phone landing order** - no band; plain head; one column
  in order needs-fix, drop zone, Drafts waiting, Latest sent.
- **E "You are set"** - the landing itself, when `drafts.length >
  0 && every draft.ready`. Band / head `"{N} ready"` + `"Nothing
  has been sent yet. Sending is switched on in the next update."`
  Each ready draft opens its sitting. `"Add more"` + `"See the
  list"`. Survives a reload because readiness is server-computed
  (correction 6).

- **C1** slim top row with the fixed-order `N-of-M` pager
  (created_at ASC + id tie-break), prev/next chevrons, Back and a
  `...` menu. Delete-this-invoice is the one item in that menu
  today; it fires an Undo toast.
- **C2** two columns on desk (`minmax(0, 1fr) 420px`); form is a
  `--sp-r-card` card.
- **C3** page box: Zoom (fit/100%, zoom scrolls inside the box,
  correction 12), Rotate, "Change the page" menu through the lane
  `Menu` with `"Add pages to it"` / `"Replace the file"` /
  `"Remove the file"`. Add-pages + Replace reuse `/api/invoices/uploads`
  with the existing draft id. Replace adds first; only after the
  new row lands does the old one go to `removed_at` (correction
  12). Remove-the-file raises an Undo toast backed by the new
  `/api/invoices/files/[id]/unremove` route.
- **C4 vendor picker** - lane `Sheet`, grouped by `This site` /
  `Other vendors`, picked row marked with a tick, arrow-key nav,
  Escape closes, focus returns to the invoice-number box on pick.
- **C5** kind line with a 48 px tap area on the link (the 20 px
  defect from section 5).
- **C6** number, date, total in that order with labels above
  (correction 14, the prompt numbering restored).
- **C7 date** - text box plus a calendar button that opens the
  lane `Calendar` inside a `Sheet`. Future dates are blocked
  inline with `"That is in the future. Check the year."` (render
  wording). The 60-day confirmation is a two-button prompt:
  `"Yes, that is right"` and `"Fix the date"`. On mount the stored
  ISO is formatted by `toBoxDate()` in `dateInput.ts` so a reload
  still shows MM/DD/YYYY (correction 5).
- **C7 coding** - `"Usual for {vendor}"` heading; single-chip
  `"All of it to {code}"` when there is one usual code; row chips
  otherwise. `"Add a code"` link. `"Put the rest, $X, on {code}"`
  button when there is a balance and a top code is known. Balance
  reads `"$X left to code"` / `"Adds up"` with a tick / `"Over
  by $X"`. The 9-in-10 fill fires on total entry and shows as the
  active chip - one tap to change (correction 12).
- **C8** `"Lines are read after it is sent."`
- **C9 copy stop block** - reads `copy_match` from the check
  route. Two kinds (correction 4): `same_invoice` ("You already
  sent this one") carries three ways out including "It is the
  credit for that invoice"; `same_draft` ("You already have this
  one in your drafts") drops the credit path. The answer keys are
  the ones `duplicateCheck.ts` + `readyCheck.ts` already use:
  `is_different_invoice`, `is_credit_for` (correction 3).
- **C10 error list** - above the Check-and-send button. Pressing
  an item moves focus to the field.
- **C11 Check and send** - shared `toast()` reads exactly `"Ready.
  Sending is switched on in the next update."` Focus stays on the
  button during the check; on ready, routes to `next_draft_id`
  (server-computed by the check route) or to the landing (which
  shows E). Enter in the total box does the same (correction 12).
- **C12 "..." menu** - lane `Menu` with Delete-this-invoice.
- **C13 save line** - four states near the button: `"Saved"`,
  `"Saving"`, `"No signal. Your typing is kept on this device."`,
  `"Not saved. Changes are kept on this device."` The last is the
  terminal state of the retry loop (0.5 / 1 / 2 / 4 s backoff,
  correction 12).

Phone sitting pieces D1-D7 live in the same component. `useIsPhone()`
+ `useKeyboardOffset()` cover the React-level decisions; the rest is
CSS. D4's keyboard-lift uses `window.visualViewport` and does not
touch `layout.tsx` (correction 7).

### Section-4 server changes

1. `gl_codes.is_purchasing = true` filtered on `loadActiveCodesForSite`;
   `loadUsualCodes` now takes an optional active set and runs the
   pure helper `filterUsualByActiveSet` so the UI never offers a
   non-purchasing chip (unit-tested).
2. `patchDraft` now returns `{status: "error", detail}` for a DB
   error; the PATCH route returns 500 `save_failed` with a short
   code string, no SQL. The client retries with backoff
   (0.5 / 1 / 2 / 4 s) then stops.
3. `sort_order` on the finish route: a whole number of zero or
   more is used; anything else quietly falls back to `nextOrder`.
   The PATCH route gets the same whole-number rule; a bad PATCH
   `sort_order` is ignored (no 400 unless the whole body ends up
   empty). A good file can never leave the bucket because the
   browser sent a rubbish number (correction 1).
4. The ending of `storage_path` no longer decides the file's kind.
   The first bytes do. `mime_type` carries the detected kind;
   `file_name` is given the detected extension; no storage move
   (correction 2).
5. No signed URL is built in server HTML. `CaptureSittingRoot`
   fetches `/api/invoices/files/[id]/view` for the active file on
   mount and again if the draw fails. `PdfPage` calls back via
   `onExpired` when `getDocument` throws so the parent asks for a
   fresh 60 s link.
6. `duplicateCheck.ts :: copyCheck` returns the matched row's
   client-safe fields (`vendor_name`, `invoice_number`,
   `invoice_date`, `submission_id`), not just a boolean. The
   check route decorates `runReadyCheck`'s pure result with
   `copy_match` and `next_draft_id`. `CheckResult` extends
   `ReadyResult` (correction 4 + 6).
7. `POST /api/invoices/files/[id]/unremove` clears `removed_at`
   only when currently set. No DELETE on either table.

### Files touched for train 2b

- `src/lib/invoices/dateInput.ts` (toBoxDate helper + tests).
- `src/lib/invoices/draftLoad.ts` (fixed-order list + loadVendorNames).
- `src/lib/invoices/draftListView.ts` (new).
- `src/lib/invoices/duplicateCheck.ts` (returns matched metadata).
- `src/lib/invoices/draftWrite.ts` (error vs conflict + unremoveFile).
- `src/lib/invoices/glCodes.ts` (is_purchasing filter + filterUsualByActiveSet).
- `src/lib/invoices/latestSent.ts` (loadReturnedForSite).
- `src/lib/invoices/readyCheck.ts` + `types.ts` (ReadyResult / CheckResult + CopyMatchView + DraftListView).
- `src/app/api/invoices/drafts/[id]/route.ts` (500 on save_failed).
- `src/app/api/invoices/drafts/[id]/check/route.ts` (copy_match + next_draft_id).
- `src/app/api/invoices/files/route.ts` (drop ending check + whole-number sort_order).
- `src/app/api/invoices/files/[id]/route.ts` (whole-number sort_order).
- `src/app/api/invoices/files/[id]/unremove/route.ts` (new).
- `src/app/api/invoices/gl-codes/route.ts` (active set threaded to usual).
- `src/app/(shell)/invoices/page.tsx` (no signed URL; threads DraftListView, pager, siteName).
- `src/app/(shell)/invoices/loading.tsx` (new, landing skeleton).
- `src/app/(shell)/invoices/error.tsx` (new).
- `src/components/invoices/CaptureLanding.tsx` (A/B/E).
- `src/components/invoices/DraftsWaitingList.tsx` (new, client B6).
- `src/components/invoices/DropZone.tsx` (4-state tray + Try again + B9 sheet).
- `src/components/invoices/WhichSiteChooser.tsx` (band + phone head + counts).
- `src/components/invoices/CaptureSittingRoot.tsx` (C1-C13 + D1-D7).
- `src/components/invoices/Sheet.tsx` (new, lane sheet primitive).
- `src/components/invoices/Menu.tsx` (new, lane menu primitive).
- `src/components/invoices/Calendar.tsx` (new, lane calendar).
- `src/components/invoices/VendorPicker.tsx` (grouped, keyboard-first, picked-marked).
- `src/components/invoices/PdfPage.tsx` (onExpired callback).
- `src/components/invoices/OwnerPreviewBanner.tsx` (F3 wording).
- `src/components/invoices/useIsPhone.ts` + `useKeyboardOffset.ts` (new).
- `src/components/invoices/capture.css` (band-free phone head, grid-980 landing, D4 sticky bar with --kb-offset, Sheet / Menu / Calendar, vendor picker, coding chip + rows + balance, copy-stop, errors list, etc.).

## Train 3: sending

Train 3 makes "Check and send" actually send. The capture surface
is unchanged for the viewer when the switch is off; when the
switch is `test` or `live` the button runs `/send`, the draft
becomes an invoice via the database function
`invoices_v2_commit_send`, one PDF is built, one email goes
through the shared `src/lib/mail.ts` sender, one Slack post
fires, and (if email failed) a cron job retries for up to 24
hours. The SQL record is at
`supabase/migrations/20261120191451_invoices_t3_sending_2026_11_20.sql`
(applied on 2026-11-20; this file is the record and is never run
by the app).

### The switch

`src/lib/invoices/outboundGate.ts` reads `INVOICES_V2_OUTBOUND`.
Only the exact strings `test` and `live` leave the default `off`.
In `off` the send route refuses with 409 `sending_off` and the
retry route does nothing. In `test` new sends are stored as
mode='test' and recipients collapse to `INVOICES_V2_TEST_TO`;
Slack prefixes `[TEST]`. In `live` new sends are mode='live' and
recipients come from `INVOICE_AP_TO_EMAIL` + cc the submitter +
`INVOICES_V2_CC`.

### Recipients + mayDeliver

`src/lib/invoices/recipients.ts :: resolveRecipients(rowMode, env,
submitterEmail)` is pure: the row's own mode decides, not the
switch. A row stored as mode='test' can never resolve to the AP
address, even under switch=live. Missing env returns a
`missing_env:<NAME>` code; the caller holds the invoice with
that code - never a fallback. No real address appears in this
file, tests, fixtures or docs.

`src/lib/invoices/mayDeliver.ts :: mayDeliver(rowMode,
switchMode)` is pure. A test row delivers under test or live; a
live row only under live; switch off blocks both.

### The send route

`POST /api/invoices/drafts/[id]/send` (`maxDuration = 60`). One
endpoint, every outcome:

| kind | status | what the UI does |
|---|---|---|
| `sending_off` | 200 (+ body carries check-route shape) | Today's "Ready. Sending is switched on in the next update." or the error list. |
| `not_ready` | 409 | Error list + copy_match for the C9 stop. |
| `copy` | 409 | One sentence: "This vendor, number, date and total are already on file." Two ways out: Remove / It is a different invoice. Correction 5 - no second read, no other site's details. |
| `delivered` | 200 | Toast "Sent to accounting." (live) or "Test send. It went to the test address, not to accounting." (test). Route to next_draft_id or the landing. |
| `held` | 200 | Toast "Saved. The email has not gone yet. We will keep trying." Same move on. |

The button label flips "Check and send" -> "Checking" -> "Sending"
(after a 500 ms delay) and keeps focus for the whole wait.

### Commit + claim + deliver

`src/lib/invoices/sendCommit.ts :: commitSend(sb, draftId,
ownerEmail, mode)` wraps the RPC. The DB function is the only
writer of `invoice_submissions` in this train and stores credit
totals negative.

`src/lib/invoices/claim.ts` holds the per-row claim rule
(correction 1: supabase-js cannot run FOR UPDATE SKIP LOCKED and
this train adds no DB function). Pure `canClaim(row, now)` is
the "may I claim this row" rule; runtime `tryClaim` runs a
conditional UPDATE … .select() and owns the row only when it
returns. The send route claims before delivering (correction 2);
the retry route claims per candidate id.

`src/lib/invoices/deliverSend.ts` is the one deliver function,
used by the send route and the retry route. Server-only. Walks
mayDeliver -> load invoice + people row + build-or-reuse PDF
(outbound_file_id + storage_path + `invoice_files`
kind='outbound') -> resolveRecipients (held with the
missing_env code if any is absent) -> buildSubject +
buildEmailBody + sendSystemMail -> invoice_send_attempts row +
invoice_sends transition + invoice_submissions.email_sent on
success -> Slack post (§6 + correction 9: first attempt always
posts; later attempts post again only on delivered or gave_up).

### Retry

`GET /api/invoices/send-retry` (`maxDuration = 60`), guarded by
`isCronAuthorized`. `vercel.json` carries one line
`{"path":"/api/invoices/send-retry","schedule":"*/10 * * * *"}`;
the same route and schedule for every mode (the switch gates
delivery inside). Pulls up to 5 candidate ids via
`candidateIdsForRetry`; `tryClaim` per id; `deliverSend` in a
try, `releaseClaim` in finally. Returns counts of claimed /
delivered / held / gave_up.

### Retry schedule

`src/lib/invoices/retrySchedule.ts` is pure.
`decideRetry(firstTriedAt, attemptsSoFar, now)` returns
`{kind:"schedule", nextAttemptAt}` or `{kind:"gave_up"}`. First
three failures wait 10 minutes; the fourth waits 30 minutes; the
fifth and later wait an hour. The 24-hour cap is strictly greater-
than the first-try time, so a next attempt at exactly t+24h is
still a scheduled retry.

### PDF

`src/lib/invoices/buildOutboundPdf.ts` is server-only. Copies
each original PDF's pages (rotated by the saved `rotation`),
paints each JPEG / PNG image as a letter-sized page, attaches
WebP + damaged PDFs on the output (bytes preserved), and
appends a plain black-on-white coding page. `[TEST]` bold at the
top in test mode (correction 8); accounting prints these.
Filename: `<vendor>_<YYYYMMDD>_<number>.pdf`, or `TEST_` prefix
in test mode. Stored at `outbound/<invoice_id>/<file_id>.pdf`.
A retry reuses the stored file; the PDF is built once.

### The subject accounting keys bills from

`src/lib/invoices/emailSubject.ts :: buildSubject`. Shapes
(correction 9 + prompt §6):
 - invoice, live: `[KitchFix] | <site> | <vendor> | #<number> | $<total>`
 - credit, live:  `[KitchFix] | CREDIT | <site> | <vendor> | #<number> | $<total>`
 - test mode:     `[TEST] ` prefixed to either.
The total is shown positive with two decimals and thousands
commas regardless of the stored sign.

### Slack

`src/lib/invoices/slackPost.ts`. 3-second AbortController; never
fails the send; missing webhook returns `"skipped"`. The caller
composes the text; no dollar amount is ever posted. First
attempt posts delivered or held:<code>; later attempts post again
only on delivered or gave_up (correction 9).

### What the person sees

- Button: "Check and send" -> "Checking" -> "Sending" -> toast.
- Delivered (live): "Sent to accounting."
- Delivered (test): "Test send. It went to the test address, not to accounting."
- Held: "Saved. The email has not gone yet. We will keep trying."
- Switch off: today's "Ready..." toast, unchanged.
- "You are set" sent variant: when there are no drafts left and
  at least one invoice sent by this person at this site in the
  last 12 h, the band / head reads "<N> sent" + "Nothing else
  needs doing." Each row reads its own status word ("With
  accounting" / "Test send" / "Sending" / "Not delivered"). The
  "N ready" form stays for switch=off.
- List + drawer: one extra query per page joins `invoice_sends`.
  V2 rows read "Sending" (held), "Test send" (test + sent),
  "With accounting" (live + sent), or "Not delivered" (gave_up)
  with the sub-line "The office has been told." (correction 4:
  a test row never reads "With accounting").
- Drawer page: V2 invoices show a "See the page" button that
  fetches `/api/invoices/sent/[id]/view` (correction 7) for a
  60 s signed URL; no link in server HTML. V1 keeps its Drive
  link.
- A sent draft's old address (`/invoices?site=..&draft=<id>`)
  redirects to `/invoices/<submission_id>`.

### Riding with this PR (from the live walk of train 2b)

 1. Twin `is_different_invoice` settles the pair in
    `duplicateCheck.ts`.
 2. "Yes, that is right" on the 60-day prompt becomes outlined
    (`kf-btn--line`) - only one filled navy button in view.
 3. Date `onBlur` reformats to MM/DD/YYYY at once. The total is
    not echoed under its box. Coding amount shows two decimals
    on blur via a focused-row state.
 4. A draft row says "Copy to settle"; the suffix " left" is
    dropped when copy is among the missing. `labelFor("copy")`
    returns "Copy to settle".
 5. `WhichSiteChooser` row arrow is a `ChevronRight` from
    lucide-react, not a typed `>`.
 6. The page is fitted to the width of its box
    (`object-fit: contain` on the canvas and img).
 7. The coding-row grid at <= 400 px makes the code picker
    `minmax(48px, 1fr)` and the amount column 100 px. The
    phonehead vendor heading and the page-tools filename span
    carry their full text in `title`.
 8. `decideCheckAction` gains an `offline` flag; `offline +
    staged` returns "stop", the button flips back from "Checking"
    and the save line says "No signal. It will send when you are
    back online."

### Files touched for train 3

Inside the fence:
- `src/lib/invoices/outboundGate.ts` (new), `recipients.ts` (new),
  `mayDeliver.ts` (new), `sendCommit.ts` (new), `claim.ts` (new),
  `deliverSend.ts` (new), `retrySchedule.ts` (new),
  `slackPost.ts` (new), `codingPageData.ts` (new),
  `buildOutboundPdf.ts` (new), `outboundFileName.ts` (new),
  `emailSubject.ts` (new), `emailBody.ts` (new),
  `submitterName.ts` (new), `recentlySent.ts` (new),
  `statusWords.ts` (new), `saveWait.ts` (offline branch),
  `duplicateCheck.ts` (twin settles pair), `draftListView.ts`
  (Copy to settle), `load.ts` (v2Send join), `types.ts`
  (V2SendStatus + v2Send on row types), `draftWrite.ts`
  (insertOutboundFile).
- `src/lib/invoices/__tests__/` - new tests for
  outboundGate, recipients, mayDeliver, claim, retrySchedule,
  codingPageData, outboundFileName, emailSubject, submitterName,
  statusWords; extended saveWait + draftListView. 103 new tests
  land across this train.
- `src/app/api/invoices/drafts/[id]/send/route.ts` (new),
  `src/app/api/invoices/send-retry/route.ts` (new),
  `src/app/api/invoices/sent/[id]/view/route.ts` (new).
- `src/app/(shell)/invoices/page.tsx` - sent-draft redirect +
  You-are-set sent variant data.
- `src/components/invoices/CaptureSittingRoot.tsx` - send flow,
  button labels, copy-stop ride, date onBlur, total hint
  removed, coding onBlur, title attrs, Yes-outlined.
- `src/components/invoices/CaptureLanding.tsx` - sent variant
  branch.
- `src/components/invoices/DraftsWaitingList.tsx` - Copy-to-
  settle status.
- `src/components/invoices/WhichSiteChooser.tsx` - ChevronRight.
- `src/components/invoices/InvoiceTable.tsx`,
  `StackedCards.tsx`, `Drawer.tsx` - status words through the
  shared helper + See-the-page button on V2 rows.
- `src/components/invoices/capture.css` - canvas object-fit,
  coding-row 400 px breakpoint.
- `supabase/migrations/20261120191451_invoices_t3_sending_2026_11_20.sql`
  - record file, verbatim.

One approved exception to the fence:
- `vercel.json` - exactly one entry added to `crons` for the
  retry job. Nothing else in that file changed. Needs an
  ownership entry (PM lane).
