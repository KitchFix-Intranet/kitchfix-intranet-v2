# Academy - engine map (train A)

The Academy ships in four trains. This repo currently contains the
engine (train A); the surfaces (room, library, records, focus) arrive
in trains B through E after their renders are approved. Point at
`claude/ACADEMY_V2_ALIGNMENT_2026-10-25.md` for the surfaces plan.

## Files in `src/lib/academy/`

- `identity.ts` - `resolveAcademyIdentity(email, { supa })`,
  `eligibleCountInScope(identity, { supa })`,
  `canSeeStandingCard(identity, opts)`,
  `canSeeHourlyRoster(identity, opts)`. One function answers "who
  is this signed-in person and what Academy scope do they hold?"
  Allowed sources: `people` (joined on `work_email` with
  `status='ACTIVE'`), `accounts`, `academy_person_stints`,
  `academy_eligibility_exceptions`, `academy_grants`,
  `academy_region_leads`. Forbidden sources: `contacts.role`,
  `src/lib/admin.js` allowlists, `user_accounts_derived`,
  `user_accounts_manual`. A duplicate active `people` row for one
  email is a defect, not a fallback - the resolver logs loudly and
  returns `null`. Scope precedence (strict, first-match):
  `academy_admin` -> company; email in `academy_region_leads` ->
  region; `people.is_site_leader` -> site; otherwise self.
- `requirements.ts` - the issuance engine. `evaluateEligibility`,
  `validateAudienceScope`, `evaluateCycleScope`, `planCyclePublish`
  + `applyCyclePublish`, `planOnboarding`, `planRehire`,
  `applyRequirements`. Nothing in train A calls these; they exist
  for train E. One `evaluateEligibility` is the single source of
  truth so cycle publish, onboarding, and rehire can never drift.
- `room.ts` - `loadRoom(email, supa?)`. Powers `/api/academy/room`.
  Returns viewer identity, queue (requirements enriched with doc +
  obligation + cycle), queueSummary, yearTrack, nextCycle, and -
  for company/region scope only - companyStanding.
- `library.ts` - `loadLibrary(email, supa?)`. Returns the active
  document catalogue grouped by shelf, plus the per-doc "trains
  you" marker.
- `records.ts` - `loadRecords(email, supa?)`. Ledger surface - the
  viewer's signatures / waived / outstanding, and (for
  `academy_admin` holders only) the company-wide signatures view.
- `module.ts` - `loadModule(email, requirementId, supa?)`. Returns
  everything the Focus view needs: doc meta, pre-rendered HTML,
  step boundaries (600 words per step; descends when a parent
  heading runs long; merges undersized descended siblings), the
  approved questions WITHOUT `correct_option_id`, the viewer's
  attempt summary, any existing attestation, and the resume-at
  index.
- `attestation.ts` - `buildAttestationSentence({ displayName,
  moduleTitle, documentTitle, version })`. Server-side only. The
  sign handler calls this and ignores any client-supplied
  attestation text.
- `certificate.ts` - `createCertificatePdf({ attestation, doc,
  obligation })`. Server-only pdf-lib dependency. The certificate
  prints the VERBATIM `attestation_text` stored on the row and
  reports attempts honestly - if it took three tries, it says
  three. Date formatting goes through `Intl.DateTimeFormat` with
  an explicit `en-US` locale (handler returns are ISO strings; the
  PDF is the one presentation layer that must render a date).

## Routes under `src/app/api/academy/`

Every route starts the same way:

```ts
const g = await requireOwnerApi();
if (g instanceof Response) return g;
// g.email is lowercased by sessionEmail()
```

A signed-in `kitchfix.com` account not in `OWNER_EMAILS` gets 404
from every one of these (DESIGN.md battery item 12).
Unauthenticated requests get 401 from `src/proxy.ts`.

| Route | Method | Response | Gate |
|---|---|---|---|
| `/api/academy/whoami` | GET | JSON | owner |
| `/api/academy/room` | GET | JSON | owner |
| `/api/academy/library` | GET | JSON | owner |
| `/api/academy/records` | GET | JSON | owner |
| `/api/academy/module/[requirementId]` | GET | JSON | owner + requirement must belong to viewer |
| `/api/academy/check` | POST | JSON | owner + requirement must belong to viewer |
| `/api/academy/progress` | POST | JSON | owner + requirement must belong to viewer |
| `/api/academy/sign` | POST | JSON | owner + five gates + displayName match |
| `/api/academy/certificate/[attestationId]` | GET | application/pdf | owner + (owner-of-attestation OR `academy_admin`) |

### Append-only tables

Two tables see INSERT from this code and never UPDATE or DELETE:

- `academy_attestations` - the signature ledger. A row is permanent
  once written. The database refuses UPDATE / DELETE / TRUNCATE on
  this table for the service role; adding a code path that would
  try is a defect.
- `academy_check_attempts` - every attempt, right or wrong, is
  evidence. Same refusal grants as attestations.

The sign handler is idempotent on primary-key conflict for
`attestation_id`: the client generates the UUID before submitting;
if the row already exists, the handler returns 200 with the
existing row. This covers dropped-connection retries without
double-signing.

### correct_option_id never leaves this engine

`correct_option_id` on `academy_questions` is server-only. The
`module.ts` loader uses an EXPLICIT column list that OMITS the
column; the only query in the codebase that reads it is the grader
inside `check/route.ts`, and the value is compared in memory and
never returned to the caller. A grep across `src/app/api` +
`src/lib/academy` for the string MUST return only that grader + the
comment block explaining the trap. A refactor that swaps the module
loader to `select("*")` would leak every answer in the system.

### Test signatures are never written against a real person

The sign route IS the one route that lands a signature. A test run
that reaches a successful `/api/academy/sign` INSERT against a real
owner email writes a permanent row in `academy_attestations` that
cannot be deleted (the append-only grants refuse DELETE even to
service_role). Probing the sign gates is a train-A deliverable;
reaching a successful sign is NOT. Live pilot signatures happen in
train C with Kevin as the first signer.

## Parity probe

`scripts/_academy_parity.ts` runs the v1 route handlers against the
same database (via subprocess, inside a sibling v1 clone) and the
v2 TS loaders in-process, diffing per surface. Known ignorable
fields: `last_seen_at`, `started_at`, `rendered_at`, `issued_at`,
`attempted_at`, and `module.questions[*].options` order (shuffled
server-side per request). Any other difference between v1 and v2 on
the same email is a port error.

## Library: the may-read rule

Every Library read path answers "may this viewer read this document?"
through one function in `src/lib/academy/access.ts`:

    resolveReaderLevel(email, identity) -> "reads_all" | "reads_unrestricted"
    canReadDocument(level, access_level) -> boolean

Reader levels (coarse to fine, so a third one can slot in below
without touching callers):

- `reads_all`          - owner only, per Kevin's ruling 2026-11-17.
                         Region leads and `library_admin` /
                         `academy_admin` grant holders read the 70
                         unrestricted documents like everyone else.
                         Lifting them back to reads_all is a later
                         ruling, not L1.
- `reads_unrestricted` - every other signed-in person the app gate
                         lets in - region leads and the two admin
                         grant holders included. Fails closed: a
                         null or unknown `access_level` is treated
                         as restricted.

`loadLibrary`, `loadLibraryIndex` and `loadDocument` all enforce it
server-side; a restricted row never reaches the client payload for a
viewer whose level is `reads_unrestricted`. `loadDocument` runs a
stage-1 gate fetch (`id, status, access_level` only) before fetching
title / card_line / summary / content / siblings / attestations, so a
restricted doc's row and content are never read for a viewer who may
not read it. For such a viewer, `/library/<id>` serves the kept-for
state built from the shared `.kf-empty` primitive - the number only,
no title, card_line, summary, owner, approver, dates, contents list
or body.

`resolveReaderLevel` still accepts `identity` so a later ruling can
widen the rule without changing callers: lifting
`identity.scope.kind === "region"` or `library_admin` /
`academy_admin` grant holders into `reads_all` is a one-branch edit
inside this file. A future `reads_operator` level will sit below
`reads_unrestricted` for `audience='operator'` documents once the
phone link ships; the enum widens, callers do not.

The Academy readers (`room`, `records`, `module`, `sign`, the
certificate route) do not yet filter by `access_level`; a restricted
doc can surface to a non-owner through the requirement-assignment
channel if one is ever assigned. An access-level gate at
cycle-publish time (or per-surface) is a follow-up train.

## Library: the bookcase

`/library` is one landing page - IdentBand (desktop) or a plain phone
heading, then a search field, a sticky shelf list, and the shelves of
tiles - all fed by one `loadLibrary` in `src/lib/academy/library.ts`
(the L1 split into `loadLibrary` + `loadLibraryIndex` is folded; a
single call powers the count, the shelf list, the shelves and the
search list). The may-read rule above runs first: a restricted
document never reaches the payload for a viewer whose level is
`reads_unrestricted`, so every count on the page is the same count
the viewer could reach by navigating. Empty shelves are dropped. The
old `LibraryFind.tsx`, `ShelvesBrowser.tsx` and
`/library/shelves/loading.tsx` are deleted; `/library/shelves` 308s
to `/library`.

The `LibraryDoc` shape carries two derived tile marks - `has_es`
("another live readable doc with id `<id>-ES` is in the catalogue")
and `posted_on_wall` (mirrors `documents.print_required`) - rendered
as shape + words, never colour alone. R-AC26 keeps the reading-level
mark and the Academy mark off the tile. Filled-in-by-a-leader is
omitted: no column in `documents` or `academy_obligations` encodes it
today.

Headline reads `<N> documents on <M> shelves`, kick `Each one is the
current version.` Search is document-level (R-AC10) via `?q=`. The
match-count line is one visible `<p role="status">` directly under
the search field - the sighted reader and the screen reader read the
same words once ("`No documents match "<q>"`" or "`N documents match
"<q>"`"). When the search finds nothing, the empty-state block that
appears in place of the shelves is a plain `<section>` (not a second
`role="status"` region); only the matchcount `<p>` announces. There
is no `sr-only` duplicate and no competing live region, so the SR
never reads the same words twice. Pressing a shelf in the sticky
list scrolls the page to it and moves focus to that shelf's `h2`.

Phone opens with a plain heading (the shell hides the band), then
the kick, the search field, a horizontally-scrolling shelf-jump
strip, and tiles stacked one per row. The shelf heading keeps
`--sp-t-title` on phone so the bookcase stays at five distinct type
sizes on every width (13 / 14.5 / 16 / 18 / 24).

A new-and-changed row is not built. `documents.updated_at` carries
seven distinct days across 82 Live docs with 27 docs sharing one day
(batch rewrites, no honest signal); `effective_date` and
`approved_date` are similar; `next_review` is uniformly null. The row
waits for a per-doc `last_substantive_edit` column or a supersedes
chain.

Evidence lives in `scripts/_library_l1_probe.ts` (updated for the
one-loader API; owner 82, every other kind 70, restricted kept_for,
unknown 404) and `scripts/_l2_battery.mjs` (Playwright chromium
headless, signed in via Supabase admin `generateLink` + `@supabase/ssr`
`setSession` cookies, sweeps 360-1920 step 40 x four states against a
local build on `:3100`, reports sideways scroll, under-48 controls,
distinct type sizes, clipped text, contrast pairs and console
errors).

Not in the L2 train: editing / publishing / Changes / Reviews,
section-level search, the IdentBand right-slot for the search, and
the shell-menu link to `/library/shelves` (the 308 keeps clicks
correct). These are shared-foundation or later-train work.

## Library: the document page

`/library/<id>` is the reading surface. A document is one thing, so
the page carries no navy band: it opens with the words.

The chrome:

- **Back**, in the top bar, says where it goes. Three shapes:
  "Back to the Library" by default; "Back to search" when the URL
  carries `?q=` or `?from=search` (the search term is kept so the
  reader lands where they left); "Back to the last document" when
  the URL carries `?from=/library/<docId>` (an in-text link set
  this). On a phone the button reads "Back" or "Library" per the
  render. A cold-pasted link (no history we control) falls back
  to the Library. Browser Back agrees with the control: both go
  to the same address.
- **Four tools** in the top bar, right-aligned as outline buttons:
  Details, Share, Print, Suggest an edit. At `>=1280` each
  carries its text next to the icon. At `1024-1279` the three
  non-Details controls collapse to 48 x 48 icon targets; the
  word stays in `aria-label` + `title`. At `<=1023` Details hides
  (the About card is already stacked above the article at this
  width) and Print hides (the phone is read-only), leaving
  Share and Suggest an edit as the two icon-only controls.
  DESIGN.md flags the slot as "one or two controls", so the
  four-control count is drawn here as a lane request; the
  shared-foundation lane rules on whether to widen the slot.
- **Contents** (`DocNav`) sits on the left at `>=1181`, scroll-spy
  highlights the section in view, and pressing an entry moves
  focus to the section's `h2`. Below `1181` the list folds into
  a `<details>` above the article; the words lead.
- **About**, the third column on the right at `>=1281`, shows
  version, published date, owner, and approver. Below `1281` the
  column hides and the top bar's Details opens a panel with the
  full fact set (Number, Kind, Version, Status, Owner,
  Approver, Approved, Reviewed, Next review, Shelf, Languages).
- **Section addresses.** Every heading gets a stable `id=`
  server-side via `buildOutline` in `src/lib/academy/outline.ts`;
  the slug is the heading text run through a conservative
  slugifier and de-duplicated by document order (`-2`, `-3`,
  ...). Opening `/library/<id>#<section>` lands on that section
  with focus on its heading.
- **Links between documents.** Where a document's text names
  another live document by number, server-side
  `wireCrossDocLinks` resolves the number through L1's rule: a
  readable sibling becomes `<a class="kf-doclink"
  href="/library/<id>">`; a sibling the viewer may not read
  becomes a plain mono span with no hint. The viewer never sees
  a dead link to a kept-for-management document.
- **Spanish and English.** A readable Spanish sibling surfaces a
  plain link next to the title ("Leer en espanol"); the Spanish
  copy shows the reciprocal ("Read in English"). No language
  toggle yet; that is a later train.
- **End of the document** reads "Something wrong or out of date?
  It goes to <owner>, with your name." and offers Suggest an
  edit, Share, and Back.
- **States.** Loading uses the shell's layout `loading.tsx`;
  not-found and non-Live resolve to the plain 404; the L1
  kept-for state (unchanged) renders the shared `.kf-empty`
  primitive at the id only.

R-AC26 holds end to end: no "trains you", no signature line, no
"Open in Academy" link; the reader on this page never sees an
Academy marker.

## Library: Share

A small panel on the right of the page (full-height sheet on a
phone). The link field is readonly and selects on focus; the
shown link is the document's own address, or the section's when
"Share just this part" is ticked and a section is picked. Buttons:
Copy link (uses `navigator.clipboard.writeText` with an
`execCommand` fallback, announces via the shared toaster when the
link lands on the clipboard; falls back to selecting the input
when the host refuses), Email (opens the person's mail client
with the subject and a line naming the doc + link), Text (same
but `sms:`), and the phone's own share sheet when `navigator.share`
is defined.

The link carries no access. Whoever opens it needs their own
sign-in, and L1 decides what they see. No token, no name, no
email address is written into the link. Nothing is sent by the
server.

## Library: Suggest an edit

Readers tell the owner something should change; the owner reviews
later from a plain owner page. Nothing in the document becomes
editable through this path - a suggestion is a note, not a diff.

The reader's side opens from three places: the top bar, the end
of the document, and the quiet "Suggest an edit about this part"
link at the end of every H1 section (48-px tap target, label at
`--sp-t-label` so the article's existing size count does not
grow). On a phone the dialog fills the height. The form has
three parts:

1. Which part - a `<select>` that defaults to "The whole
   document" and lists the article's H1 sections. When the
   reader opens the panel from a per-section control, that
   section is prefilled. `injectSectionEndControls` in
   `src/lib/academy/outline.ts` inserts the per-section buttons
   into the server-rendered HTML; a delegated click listener on
   `[data-kf-sec-anchor]` inside `DocControlsIsland` reads the
   anchor + heading text from the clicked element, fires the
   same custom event the top-bar toolbar uses, and the opener
   is refocused on close.
2. What should change, and why - required; cap 4000 characters.
3. Their own wording for that part - optional; cap 8000
   characters; only available when a section is picked. There
   is no point rewriting "the whole document".

A half-written note lives in `localStorage` under
`kf-lb-sug:<docId>` on that device only, and comes back when the
panel reopens. Pressing Send clears the draft and shows a toast
("Suggestion sent to <owner>. Nothing in the document changes
until they publish."). Pressing Discard clears the draft without
sending. A failure leaves the draft in place and shows a plain
sentence; Try again sends the same text.

The write route `POST /api/academy/library/suggestions` is the
only path that lands a row. Gates (every must pass):

- **App-access gate.** `requireAppAccessApi("/library")` - a
  static path, never built from request input. The release switch
  and `isOpenedPath` answer against the opened prefix, not against
  a crafted string a caller could shape. The per-document may-read
  check is a separate layer inside `submitSuggestionForEmail`.
- **Shape check first.** The handler rejects any `docId` whose
  shape does not match the document-number regex
  (`/^[A-Z]{2,6}-\d{3}(?:-[A-Z]{2,4})?$/`) before any gate or DB
  lookup. A bad shape never reaches the gate, never reaches the
  database, and never participates in any routing decision.
- **May-read, server-enforced.** The function in
  `src/lib/academy/suggestions.ts::submitSuggestionForEmail` runs
  stage-1 against `documents` (id, status, access_level), refuses
  when the status is not Live, and resolves the viewer's reader
  level through `resolveReaderLevel` + `canReadDocument`. A
  suggestion against a restricted document is refused with the
  **same** 404 answer as a document that does not exist: no
  difference in wording, status, or timing that would confirm it
  exists.
- **reporter_email is server-sourced.** The function accepts an
  `email` argument; the route handler sets it from the session
  (`g.email`). The route body is read for `docId`, `issueText`,
  `sectionKey`, and `suggestedText` only; a `reporterEmail` key
  in the body is ignored.
- **section_key is a real section.** `lookupSection(docId,
  anchor)` rebuilds the outline from today's body and refuses
  when the anchor does not match. `section_title` and
  `doc_version` are looked up at the same time and stored on the
  row; the client cannot rename a section through this path.
- **Length caps on the server.** `issue_text` 1-4000 characters
  (trimmed; empty refused with 422); `suggested_text` 0-8000
  (empty becomes null; over the cap refused with 413).
- **Rate limit, fail closed.** Two caps, both counted directly
  against `document_issues` (no new table):
  - **Burst**: 5 open suggestions per `reporter_email` per
    rolling 60 s (`status='open'` + `created_at > now()-60s`).
  - **Daily**: 30 suggestions per `reporter_email` per rolling
    24 h, counted **regardless of status** so an owner closing
    old notes does not refill the quota.
  If either count query returns an error, the submission is
  refused (`rate_limited(count_query_failed)`). A race between
  parallel submits is survivable; the probe fires 8 in parallel
  to trip the burst cap and pre-seeds 30 closed rows to trip the
  daily cap. The write path uses the index
  `document_issues_doc_status_idx` on `(doc_id, status)` that the
  migration adds.

The route answers with nothing about other people's notes. On
success it returns `201 { ok: true }` and no row body - the
reader does not need the id, and the owner's list is the only
place suggestions leave.

**Plain text only.** `issue_text` and `suggested_text` are stored
as whatever the reader typed (trimmed); the owner's list renders
them inside React text nodes, so angle brackets survive as
literal characters. `dangerouslySetInnerHTML` is never pointed at
either column. The probe stores `<b>x</b>` + a script tag and
confirms both come back escaped.

**The owner's side** is `/library/suggestions` (requireOwnerPage).
Three lists on one page, each showing its own count:

- **Open** - notes waiting to be read. Default list.
- **Accepted - not changed yet** - notes the owner has said Yes
  to but the document source has not been updated for yet.
- **Closed** - done and declined notes, newest first. Each one
  says which it is. Nothing ever just disappears.

The storage schema holds four screen-visible states inside the
two columns the table already has:

| Screen label                | `status`      | `handled_outcome` |
|-----------------------------|---------------|-------------------|
| Open                        | `open`        | null              |
| Accepted - not changed yet  | `in_progress` | `used`            |
| Done                        | `closed`      | `used`            |
| Declined                    | `closed`      | `no_change`       |

The stored values stay as they are (`used` + `no_change` are the
only values the `chk_issue_outcome` constraint allows); only the
screen words change. L4b adds one text column, `handled_note`,
for the optional decline reason.

The actions a note moves through:

- **Accept** (filled button on an Open note) - moves to
  Accepted - not changed yet. Keeps the owner who accepted and
  when, until Mark as done closes it.
- **Mark as done** (filled button on an Accepted note) - moves
  to Closed as Done. The owner page says in one plain line that
  accepting does not change the document yet: the change is
  made in the document's source for now.
- **Decline** - opens a step with an optional reason (plain
  text, capped at 2000 characters, stored on `handled_note`)
  and moves the note to Closed as Declined.
- **Put back to Open** - on any Accepted or Closed note.
  Clears `handled_by`, `handled_at`, `handled_outcome` and
  `handled_note`.

Every row carries three more controls: **Open the document
here** (goes to `/library/<id>#<section>?from=/library/suggestions`
so BackLink on the document page lands back here), **Reply**
(a plain `mailto:` link to the sender with a subject naming the
document and a body that quotes the note; nothing is sent by the
server), and - where the reader wrote their own wording - a
"Reader's wording" block that shows that text clearly apart from
the note. A failed action is a designed state: the row stays
where it is and the reader-written fields stay in view.

All four actions go through one route:
`POST /api/academy/library/suggestions/[id]/action` body
`{ action, reason? }`. `requireOwnerApi` is the first thing the
handler runs. The function `applyOwnerAction` in
`src/lib/academy/suggestions.ts` refuses a move that does not
make sense from the row's current state (409 `wrong_state`) and
never trusts the request for who is acting - `handled_by` comes
from the session email only.

The **bookcase snippet** that shows the owner how many notes need
their attention is counted as Open plus Accepted-not-changed-yet
(`countActiveSuggestions`); Closed does not light the badge.

The sender's email is the one place a reader's address is shown
across both pages. It is never written into an address, a log
line, or an error message.

## Library: your suggestions

`/library/suggestions/mine` is the reader's own list. Any signed-
in person the gate lets into the Library sees only their own notes,
newest first. The server decides whose notes these are from the
signed-in session (`requireAppAccess` runs first, then
`listMineForEmail` is called with the gate's email); no email or
id is in the address or in the request. A person can never see
anyone else's note or anyone's email on this page - the payload
is scrubbed of `reporter_email` before it leaves the server, so
not even the viewer's own address ends up in the markup.

Each row shows: the document number and title, the part, what the
reader wrote, and what happened: Open, Accepted, Done, or Declined
with the reason if one was given. Read only. If a note is on a
document the person can no longer read by L1's rule, the document
number shows but the title is `null` and no link is drawn.

Readers reach the page from two quiet places and nowhere else:

- A **See your suggestions** link inside the send-confirmation
  that opens in the Suggest panel after a successful submit
  (the panel's body swaps to a short "sent" view with the
  link; the reader presses Close to dismiss it).
- A **Your suggestions** control in the end-of-document close,
  rendered only when the server says the viewer has at least
  one note (`hasOwnSuggestions`). A reader who has never sent a
  note never sees it.

The shell menu is untouched. Nothing on the shell level knows
about `/library/suggestions/mine`.

The two June rows and the one 2026-11-20 row have no
`section_key`, no `section_title`, no `suggested_text` - they
render cleanly ("The whole document", no reader wording block).

The fuller office queue - reading the wording against the
document, taking it into a draft, bulk-closing a day's stale
notes - is a later train.
