# Service Calendar - Lane doc

Lane: Service Calendar (SC). This file is updated in the same PR as the SC work it describes.

## Train 6 - reminders and notifications (2026-11-20)

Behind the existing `SC_V2_OUTBOUND` gate. Inert in production until the gate flips; test mode routes every send to Kevin only. Wires the new shared `src/lib/mail.ts :: sendSystemMail` through the lane's single door (`src/lib/sc/outbound.ts`).

### The two cron reminders

- **Friday 3 PM Central**. If the current week at a calendar site is not submitted yet, mail the salaried site leaders. One send per (account, week, is_test). Biweekly sites only fire on the pair's CLOSING Friday (week_label "Week 2" or "Week 4" on `sc_day_metadata`); opening weeks are skipped.
- **Monday 9 AM local**. If last week is still not submitted, mail the leaders + any regional directors for the region. The body branches on `isBilled`: billed sites read "accounting reviews today, invoices go out Tuesday"; non-billed sites read "so it is on record". Trailer line reads `tell <RD first name>` for a single RD, `tell your regional director` for multiple, and `tell the office` when none are on record (Kevin ruling 2026-11-20).

Dates and the closing-week decision come from `resolveFinalizeReviewSpan` (the engine helper the submit, the sites board and the reopen already use). "Asked yet" delegates to `src/lib/sc/calendar/isAskedYet` with the site's Chicago-stable today, so the calendar, the sites board and the reminders agree on the verb.

Cron entries (vercel.json):

```
/api/service/reminder-friday  0 20,21 * * 5
/api/service/reminder-monday  0 13-17 * * 1
```

The Friday window covers CST + CDT with one firing at 15:00 Central. The Monday window covers 9 AM in America/New_York, America/Chicago and America/Phoenix across both standard and daylight time. Each handler asks `isFridayCentralHour(now)` / `isMondayNineAtTz(now, site.timezone)` and no-ops off-hour ticks. All day/hour decisions flow through `Intl.DateTimeFormat`; no hand-coded DST.

### Auth

Real runs are cron-only (`isCronAuthorized` or the route returns 401 `CRON_ONLY`). An owner session is accepted only with `?dry=1`. The dry run composes the full decision for every site under any mode (including `off`), writes nothing, sends nothing.

### Dry-run output shape (per site)

```json
{
  "accountKey": "SITE - XY",
  "weekStart": "YYYY-MM-DD",
  "unitStart": "YYYY-MM-DD",
  "unitEnd":   "YYYY-MM-DD",
  "decision":  "remind" | "skip",
  "reason":    "already_submitted" | "not_asked_yet" | "no_service" |
               "not_closing_week" | "already_reminded" | "no_recipients" |
               "wrong_hour" | "error" | null,
  "leaders":   <count>,
  "directors": <count>,
  "mode":      "off" | "test" | "live"
}
```

No `to`, no `cc`, no names, no `subject`, no `html`. The real run's response is the same shape plus `outcome: "mode_off" | "sent" | "failed" | "skipped"`; it carries no addresses either.

### Skip ladder (in order)

1. `not_closing_week` - biweekly opening week (week_label "Week 1" or "Week 3").
2. `already_submitted` - sc_week_finalize row with status <> 'reverted'.
3. `not_asked_yet` - `isAskedYet` returns false for the site's today.
4. `no_service` - every row in `sc_daily_revenue` across the unit has `actual_count = 0` AND `projected_count = 0` (the Dec 21 + Dec 28 holiday weeks sit here).
5. `no_recipients` - leaders + directors both empty under `live`; recorded with `email_result='skipped_no_recipients'`.
6. `already_reminded` - sc_v2_reminder_sent row already present for (account, week, stage, is_test).
7. `error` - one site threw; the route moves on to the next (per-site try/catch).

### Ledger table

`sc_v2_reminder_sent` (9 columns, RLS on, service_role only). One row per reminder actually attempted. `is_test` is part of the unique index so a test-mode reminder does not "use up" the real one. Record of the applied migration lives at `supabase/migrations/20261120193256_sc_v2_reminder_sent_2026_11_20.sql`. V1's `sc_week_chase_sent` is untouched.

### The no-invoice notice (owner only)

A submit on a NON-billed site tells Kevin ONLY (Kevin ruling 2026-11-20). Billed sites already get the engine's N1 inside the push pipeline; this is the counterpart for the sites v1 did not notify about at all. Fires from the submit-week route's `after()` block when `!site.isBilled`. The submitter is named from `people.display_name` ("Someone" fallback) - no email address in the body. No dollars, no cents, no before-tax line. Meals stay.

### Carry-in: FinishOverlay SR line

The overlay previously read raw ISO. The SR span now reads plain words in the site's timezone via `finishOverlaySr()`:

- Weekly: `Submitted Monday, Nov 23 at 9:35 AM. Week of Nov 16 - Nov 22.`
- Biweekly: `Submitted Monday, Nov 23 at 7:35 AM. Two weeks of Nov 9 - Nov 22.`

No year, no zone letters, no "Unit span". ReviewPage passes `view.site.timezone`; the overlay re-uses its existing `isBiweekly` prop to select the pair variant.

### Divergences from the engine

Three engine files carry additions:

- `src/lib/sc/scWeekFinalize.ts` - `buildScWeekLink` + `buildRetryLink` rewrite to emit V2's `/service/review?site=<slug>&week=<Monday>` via a lane-local `appBaseUrl()` helper (`SC_APP_BASE_URL` with the V2 production domain as fallback). V1 built against `NEXT_PUBLIC_APP_BASE_URL` which is not set on V2's Vercel project.
- `src/lib/sc/billing/qboNotifications.ts` - added `EMAIL_SENDER` + `EMAIL_DISPLAY_NAME` to the `_internals` export so lane code can reuse the engine's sender constant by import instead of copying the literal.
- `src/lib/sc/outbound.ts` - the lane seam's `sendEmailSA` in `test` and `live` is a thin call to `sendSystemMail`; `off` remains byte-identical to train 1.

### Files added

- `src/lib/sc/submit/appBaseUrl.ts`
- `src/lib/sc/submit/reminderMode.ts`
- `src/lib/sc/submit/reminderGreeting.ts`
- `src/lib/sc/submit/reminderScheduler.ts`
- `src/lib/sc/submit/reminderRecipients.ts`
- `src/lib/sc/submit/reminderRender.ts`
- `src/lib/sc/submit/reminderSend.ts`
- `src/lib/sc/submit/n1NoInvoice.ts`
- `src/lib/sc/submit/finishOverlaySr.ts`
- `src/app/api/service/reminder-friday/route.ts`
- `src/app/api/service/reminder-monday/route.ts`
- `supabase/migrations/20261120193256_sc_v2_reminder_sent_2026_11_20.sql` (record of applied change)
- 12 test files under `src/lib/sc/submit/__tests__/`

### Files modified

- `src/lib/sc/scWeekFinalize.ts` (link builders)
- `src/lib/sc/billing/qboNotifications.ts` (`_internals` export adds `EMAIL_SENDER`, `EMAIL_DISPLAY_NAME`)
- `src/lib/sc/outbound.ts` (`sendEmailSA` now calls `sendSystemMail` for test + live)
- `src/app/api/service/submit-week/route.ts` (after() owner notice; resolves submitter name from `people`)
- `src/components/service/review/FinishOverlay.tsx` (siteTimezone prop; isPair passed through to SR)
- `src/components/service/review/ReviewPage.tsx` (pass timezone)
- `vercel.json` (two cron lines)

## Train 5 - reopen a submitted week (2026-11-20)

One action: a submitted week goes back to open so its numbers can be corrected and submitted again. In v1 the word was "revert"; in V2 the word on screen is **reopen**. The master's rule set from the arc kickoff is unchanged — this train lands the plumbing.

### The route

**`POST /api/service/reopen`** — body `{ accountKey, weekStart, reason }`. Not a verb on `/api/service/submit-week`; nothing it shares with submit is reused, and a separate path keeps the audit of "what touched invoices" readable.

Gate order (Kevin ruling 2026-11-20):

1. `requireOwnerApi()` → 401/404 verbatim.
2. Resolve the viewer + the account; the viewer must have scope on the account. 403 `NOT_AUTHORIZED` → "You do not have access to this site."
3. `canReopenForAccount(sb, email)` — any ACTIVE `people` row with `is_sc_lock_override = true` (role `override`) OR `is_regional_director = true` (role `rd`, **no region bind**). 403 `NOT_ALLOWED` → "Reopening a week is for the office and the regional directors." The `role` is server-only; it is never shipped to the client.
4. Validate reason: non-empty, trim, ≤ 280. 400 `REASON_MISSING` / `REASON_TOO_LONG`.
5. If `role === 'rd'`: look up the fiscal period that holds `weekStart`, call `sc_is_period_closed_fy`. On `closed = true` **or any read error**, refuse with 403 `PERIOD_CLOSED` → "This period is closed. &lt;first names&gt; can reopen it." The first names come from `people` where `is_sc_lock_override = true, status = 'ACTIVE'`, never a string in code. Any failure to read falls back to "the office".
6. `reopenWeek(sb, args)` — eleven steps, returns the specific refusal code per the table below. Status codes: `NOT_LIVE` 404; `NOT_V2`, `CANNOT_REOPEN_STATUS`, `OUTBOUND_OFF_HAS_INVOICE`, `WEEK_HAS_LIVE_INVOICE` 403; `QBO_CHECK_FAILED` 502; `LEDGER_SUPERSEDE_FAILED`, `REOPEN_WRITE_FAILED` 500.

### The refusal words

| Code | Message |
|---|---|
| `NOT_AUTHORIZED` | You do not have access to this site. |
| `NOT_ALLOWED` | Reopening a week is for the office and the regional directors. |
| `PERIOD_CLOSED` | This period is closed. &lt;first names&gt; can reopen it. |
| `NOT_V2` | This week was submitted in the old calendar. Reopen it there. |
| `NOT_LIVE` | This week is not submitted, so there is nothing to reopen. |
| `CANNOT_REOPEN_STATUS` | This week cannot be reopened from here. Tell the office. |
| `OUTBOUND_OFF_HAS_INVOICE` | This week has an invoice, and billing from this calendar is switched off right now. It cannot be reopened here yet. |
| `WEEK_HAS_LIVE_INVOICE` | QuickBooks still holds invoice &lt;number&gt;. A voided invoice still counts. Accounting deletes it in QuickBooks first. |
| `QBO_CHECK_FAILED` | QuickBooks could not be reached, so the week was not reopened. Nothing changed. Try again in a few minutes. |
| `LEDGER_SUPERSEDE_FAILED` | The invoice could not be marked as replaced, so the week was not reopened. Tell the office. |
| `REOPEN_WRITE_FAILED` | The week was not reopened. Tell the office before trying again. |

`NOT_V2` is the one place the old calendar is named, because that is where that week lives. `REOPEN_WRITE_FAILED` names no partial state on screen — the recovery path (second run finds no live ledger rows, step 9 runs) completes the reopen; a test pins it.

### How "is this invoice still in QuickBooks?" is answered

`src/lib/sc/submit/qboCheckInvoice.ts` — the three-way wrapper around `composeQueryUrl` + `networkFetch` + `QBO_PROXY_KEY`. Given `{ qbo_doc_number, qbo_invoice_id }`:

- Ask by **DocNumber** when set, and by **Id** when set. Both queries use `SELECT * FROM Invoice WHERE <col> = '<escaped value>'` (single quotes doubled). Each goes through `networkFetch`, so `SC_V2_OUTBOUND = 'off'` throws before the wire (the route maps that case to `OUTBOUND_OFF_HAS_INVOICE` earlier when a live ledger row exists).
- **still_there**: either side returned a row. Voided invoices (`Balance = 0`, `PrivateNote = 'Voided'`) are **still entities in QuickBooks** and read as still_there. Kevin ruling 2026-11-20 train 5: V2 refuses on voided too; v1's message accepted a void and we are not inheriting it.
- **gone**: both asked sides returned zero rows.
- **cannot_ask**: either asked side errored (relay error, parse failure, `networkFetch` threw), or the ledger row holds neither value, or the relay credentials are missing.

The four big-league accounts use `qbo_doc_number` + `qbo_invoice_id` today; the AND discipline means a deleted DocNumber + an orphan Id cannot pass as "gone".

### The writes, in order

With a live ledger row and QBO says "gone":

1. **`sc_export_ledger`** — one `UPDATE SET status = 'superseded', superseded_by, superseded_at, superseded_by_finalize_id = null WHERE account_key, week_start, status = 'created', is_test = false`. One statement either changes every matching row or none. Row count must equal the number of live rows we asked QBO about; mismatch → `LEDGER_SUPERSEDE_FAILED` **before** step 2.
2. **`sc_week_finalize`** — `UPDATE SET status = 'reverted', reverted_by, reverted_at, revert_reason WHERE id = <row.id>`.
3. **`sc_day_metadata`** — `clearReviewStateForDays(account, unitSpanDates)` across all 7 (weekly) or 14 (biweekly) dates. Non-fatal; logs a warning on failure.
4. **`sc_day_note_entries`** — one row on the unit's first day: `Week reopened by <name>: <reason>` or `Two weeks reopened by <name>: <reason>` for a pair. Author = the signed-in email; name resolves server-side via `people.display_name`. Non-fatal.

On a step-2 crash after step-1 succeeded, the ledger rows are `superseded` and the finalize row is still `finalized`. A second run finds no live ledger rows (step 1's WHERE matches zero), step 1 is a no-op (0 asked, 0 matched), and step 2 completes. Test `step 9 fails after 8c succeeds: a second reopen completes (ledger already superseded)` proves it.

### The ledger columns

Three nullable columns on `sc_export_ledger`, applied 2026-11-20 as migration `20261120180756`:

- `superseded_by text` — work email of the person whose reopen marked the row superseded.
- `superseded_at timestamptz` — when that happened.
- `superseded_by_finalize_id uuid` — soft link to the reopen's successor `sc_week_finalize.id`. The reopen itself writes null; a future refinement could set this at the next successful submit.

No check constraint — one row superseded by hand in September has no record and never will. Migration file lives at `supabase/migrations/20261120180756_sc_export_ledger_superseded_audit_2026_11_20.sql` as the record of a change already applied; `if not exists` on every statement so a re-run is a no-op.

### The next invoice number

`scWeekFinalize.ts:946-966` reads superseded ledger rows per `(account_key, week_start, invoice_slot)` and sets `revision = 1 + supCount`. After a reopen + re-submit the DocNumber becomes `KF<CODE><YYMMDD><SLOT>2` (first reopen), then `…3` (second reopen). Unchanged by this train — the counter uses the `superseded` rows our new write produces.

### Test-mode weeks

A week submitted while `SC_V2_OUTBOUND = 'test'` (or an account with `qbo_mode != 'live'` under `live`) carries ledger rows with `status = 'test', is_test = true`. The route's pre-flight SELECT filters `is_test = false`, so no row is a candidate for the "ask QBO" step, no row is superseded, and the reopen proceeds. The test ledger row stays — it is an audit entry.

### Mid-push + retry-pending

- **Mid-try**: the push's three completion UPDATEs in `push.ts` all filter `.neq("status", "reverted")`. A reopen that lands between claim and completion flips the row to `reverted`; the push's completion write finds zero rows. Existing test `push-revert-during-attempt.test.mjs` covers this mechanic unchanged.
- **Waiting on a retry**: the reopen UPDATE wins outright. The next cron tick's `findAndAttemptDuePushRows` claim filter `.neq("status", "reverted")` returns zero matches; `attemptPushForRow` returns `claim_lost`. Test `reopen while a push is waiting on a retry` proves it.

### The Reds' pair

The page passes the **closing** Monday (`W2` or `W4`) as `weekStart`. `resolveFinalizeReviewSpan(accountKey, weekStart, sb)` returns the 14-day unit; the ledger is keyed on `spanStart` (the pair's opening Monday); the finalize row flipped is the one at `weekStart` (the closing Monday). All 14 dates' review marks clear. The system note lands on `spanStart` with the "Two weeks" wording. Test `biweekly closing week: unit spans 14 days, note reads 'Two weeks'` pins it.

### What v1 does that V2 is not carrying over

- The explicit `isPerMealBillingAccount(accountKey)` gate (v1 route.js:2036). V2 inherits implicitly: fee sites have no `sc_week_finalize` row, so step 6's `NOT_LIVE` refuses.
- `status = 'billed'` → `WEEK_BILLED_NO_REVERT`. V2 never writes `'billed'`. `CANNOT_REOPEN_STATUS` covers a v1-era row.
- `alertReviewClearFailure` Slack alert. Outbound; silenced by the gate. The response's `clearWarning` carries the signal to the UI.
- One note per day of the unit (v1 route.js:2199). V2 writes **one** note on the unit's first day. Cleaner for the fold, same audit.
- "Re-approval required before re-finalize" copy on every day note. V2 relies on the cleared `review_status` to drive the re-look — no phrase needed.

### Where it lives on screen

On the week check of a submitted V2 week, under the "Submitted and on record" banner, visible only when `view.canReopen` is true. The server evaluates `canReopenForAccount` and ships a boolean; the role never crosses the wire. A viewer who cannot reopen sees no button.

Idle shape: one quiet `kf-btn--line` reading "Reopen this week" or "Reopen these two weeks". Clicking opens a reason textarea in place with a filled Submit. No modal, no "are you sure" prompt — the required reason is the pause. The maximum is 280 characters; the hint reads "&lt;N&gt; of 280" live.

After a successful reopen the client `router.replace`s to `/service?site=<slug>&fy=<year>&p=<period>&reopened=<weekStart>`. The calendar renders with a one-line notice above the period stage: "Week of <dates> is open again." For a pair: "The two weeks of <dates> are open again." The notice is a status role, no icon, and disappears on the next navigation.

### Files

**New (7):**
- `src/lib/sc/submit/canReopenScope.ts` — server-only scope decision.
- `src/lib/sc/submit/overrideNames.ts` — first-name list from `people`.
- `src/lib/sc/submit/qboCheckInvoice.ts` — three-way QBO wrapper.
- `src/lib/sc/submit/reopen.ts` — the orchestration.
- `src/app/api/service/reopen/route.ts` — the route shell.
- `src/components/service/review/ReopenPanel.tsx` — the client island.
- `supabase/migrations/20261120180756_sc_export_ledger_superseded_audit_2026_11_20.sql` — the record of the applied migration.

**Changed (5):**
- `src/lib/sc/billing/qboAdapter.ts` — exports `readInvoiceByDocNumber` (previously private); adds twin `readInvoiceById`.
- `src/lib/sc/submit/reviewLoader.ts` — carries `canReopen: boolean`.
- `src/app/(shell)/service/review/page.tsx` — server-side `canReopenForAccount` evaluation.
- `src/components/service/review/ReviewPage.tsx` — mounts `ReopenPanel`.
- `src/app/(shell)/service/service.css` — `.kf-sc-reopened-notice` class.
- `src/app/(shell)/service/review/review.css` — reopen panel styles + four new file-local tokens.
- `src/app/(shell)/service/page.tsx` — reads `?reopened=<iso>` on `/service` and threads it.
- `src/components/service/CalendarPage.tsx` — `ReopenedNotice` component above the period stage.
- `src/components/service/mlb/BigLeagueCalendar.tsx` — season year derived from the loaded span (train 5 carry-in 1).
- `src/lib/sc/billing/__tests__/_supa-mock-submit.mjs` — one-line extension so the reopen tests can see non-finalize inserts land.

### Tests

- `canReopenScope.test.mjs` (7): override; rd (no region bind); override wins when both flags; neither flag; terminated row only; empty email; null email.
- `qboCheckInvoice.test.mjs` (11): both-empty-gone, DocNumber-only-found, Id-only-found, voided-still-there, either-errors-cannot-ask, parse-fail-cannot-ask, neither-id-cannot-ask-no-wire, missing-creds-cannot-ask-no-wire, DocNumber-only-row-empty-gone, Id-only-row-empty-gone, single-quote-escaped.
- `reopen.test.mjs` (13): NOT_LIVE, NOT_V2, CANNOT_REOPEN_STATUS, no-live-ledger happy, QBO-gone happy, WEEK_HAS_LIVE_INVOICE, voided-same-refusal, QBO_CHECK_FAILED, step-9-fail-then-retry, biweekly-pair-14-days, row-count-mismatch (documented by the retry-completes test), OUTBOUND_OFF_HAS_INVOICE-no-wire, reopen-during-pending-push.

**Full suite after this train: 454 pass, 0 fail.**

## Train 4 - the Sites board, big-league calendar, notes and history (2026-11-20)

Three mostly read-only surfaces, plus four carry-ins from train 3. Nothing here bills, emails or changes a submitted week; the only writes are an authored note, two system notes, and the push-again reset on `sc_week_finalize`.

### The Sites board

The office and the two regional directors land at `/service` with no `?site=` on the Sites board. A site leader with one site in scope still redirects straight to their calendar, unchanged. The board shows:

- The week beside the filter: Monday of today in **America/Chicago** (`mondayCentralToday()`), one label for everyone. Each site still uses its own `sc_site_today` for the day squares and the late / exempt rule.
- One row per site, grouped under four plain headings in order of need: **Needs someone** (`push`, `late`, `stuck`, `flag`), **This week** (`open`, `entered`, `ready`), **Submitted** (`sent`, `noinv`), **Not serving** (`off`, reserved `over`). Row kind is decided by `classifyRow()` in `src/lib/sc/sitesBoard/bucket.ts`; the state word on the right is still the one `resolveWeekState` word.
- Each row's seven squares reuse `resolveDayState` and the shared `.kf-sc-sq` + `is-*` classes. A `home` day gets the home-game mark via `sc_day_metadata.game_type IN ('DAY','NIGHT')` (the calendar's own source for the four PDC + MiLB accounts that carry it; the four big-league clubhouses do not sit on this list).
- `push` is keyed on a V2 row only: `submitted_via = 'v2' AND push_gave_up_at IS NOT NULL`. Office viewers only (`is_corp && !is_regional_director`); a regional director sees the row read as `sent`. The row's right side reads **See the push** and links to `/service/review?site=&week=` — the week check page, where the "Push to QuickBooks again" button lives.
- `late` fires only when `isAskedYet()` returns true. Before fiscal 2027 (2026-12-28), a site that has never submitted stays `open`, not `late`, until the cutover. One pure function, called on the board, on the calendar home, and on the week check — same answer at all three.
- The All / East / West region filter (a segmented control, phone-friendly) shows only for an office viewer whose in-scope set has more than one region.
- A "Big league clubhouses - calendar only" sub-card lists the MLB accounts the viewer may see, with a season home-game count and a "season over" note when the last schedule row is in the past. Each row links to `/service/mlb?site=<slug>`.
- A small five-word legend sits under the main card at ≥ 861 px; narrow screens drop it and the per-row state word carries the signal.

**Reads.** One loader, one wave. For N in-scope sites + M big-league sites:

1. `sc_services` (narrows to accounts with at least one row; no `active` filter for the same reason the calendar loader keeps the inactive-row units).
2. `people` (one read for the active site leader of every N + M; display name only).
3. `sc_qbo_account_map` for the N set.
4. `sc_qbo_service_map` (export-excluded only) for the N set.
5. `sc_daily_revenue` for the N × 7 week dates, `{ count: 'exact' }` with paging (every >1000 case throws an explicit short-read error, the only shape train 1b does).
6. `sc_day_metadata` for the N × 7.
7. `sc_week_finalize` bounded to (weekStart - 7, weekEnd), `status <> 'reverted'`.
8. `sc_week_finalize` head-count per account (`status <> 'reverted'`) for the any-finalize-ever map.
9. N × `rpc sc_site_today(p_account_key)`.
10. N × `rpc sc_is_period_closed_fy` for the period that holds `weekStart`.
11. M × `sc_homestand_schedule` head-count (GAME rows).
12. M × `sc_homestand_schedule` last-row (GAME or EXHIBITION) for the "season over" flag.

No new SQL. No new database function. `sc_current_week` is not a function on this project; the central Monday is computed in-process via `Intl.DateTimeFormat`.

**Preview leans carried forward** (asked on Kevin's reply 2026-11-20, approved as-drawn): the two-line account-key mark beside the site name, the region segmented control, the mini legend, the per-row sub-line copy, and the "Big league clubhouses - calendar only" sub-card.

### The big-league calendar (`/service/mlb`)

A sibling page, not a branch of `CalendarPage`. **Monthly**, as the preview draws it: twelve months, prev/next month arrows, DOW column headers, cells carry a day number + every game on that day. A sidebar on wide screens lists the home stands overlapping the month.

**One source: `sc_homestand_schedule`.** The table ends 2026-09-27 and has no 2027 rows yet; the normal landing today is the season-over state. `sc_day_metadata.game_type` is **not read on this page** — it disagrees with the schedule on away days (the metadata carries ~20 more "away" days per account than there are away games). The schedule table holds rows for the four **big-league** clubhouses (MLB level, this train's screen) and for MiLB accounts (the PDC-side calendar's home stands, not touched here). Per-day_type counts in the four MLB-level accounts today: 81 GAME, 81 AWAY, 2 EXHIBITION (the two Texas accounts only). MiLB-only day_type values (`PREP`, `OPEN`, `CLOSE`, `CLEAN`) are dropped at the loader for this page.

Three day_type values are drawn, one per cell:

- `GAME` → "vs <opponent>" on a navy cell, with `game_time` rendered in the account's own `accounts.timezone` (never the server's). The `day_night` column is on the row but is not drawn — the time is the fact that matters.
- `AWAY` → "at <opponent>" on a muted outlined cell, no time.
- `EXHIBITION` → "vs <opponent>" on a sky-tint cell, with the time when set, and the word "exhibition" appended.
- `OFF` / `null` / MiLB-only values (`PREP`, `OPEN`, `CLOSE`, `CLEAN`) → not drawn. A plain day cell.

**Home stands.** Grouped by `homestand_id` when every `GAME` row carries one; falls back to runs of consecutive home dates (GAME or EXHIBITION, a one-day gap breaks the run) when any GAME row is missing an id. The `groupedBy` flag is returned on each stand so a future audit can report the mode without re-walking the data. Today, on every one of the four accounts, every GAME row has a `homestand_id`, so the grouper runs in id mode. A doubleheader flag is read but every row today is `false`; the cell renders a second game underneath without breaking the layout and appends "doubleheader" to the sub-line.

**Season-over state.** When today is past `lastGameIso`, the band reads "The 2026 season is done" with the last-game date in the kick; the notice below says "The 2027 games show here by themselves once the league posts them." The month pager still works across the loaded span.

**No schedule loaded** state (no rows at all for the account) says so plainly and names what will show up once the 2027 data lands.

### Notes and history

A folded line sits at the foot of the day drawer's body: **Notes and history**, closed by default. Opening it fires one wave of three reads bounded to that (account, date), and renders newest-first. The fold stays closed → zero reads.

- `sc_daily_actuals_history` (the audit trigger's per-service update + delete receipts, written as `change_type='update'` or `'delete'`).
- `sc_day_note_entries` (authored notes + system notes, append-only; no DELETE grant on this table).
- `sc_daily_actuals` for the earliest `(created_at, created_by)` — the first-entered synthesis (the UPDATE trigger does not fire on an INSERT per sc-1).

**Authors.** Every `changed_by` / `author` / `created_by` is a work email. The loader resolves each via `people.work_email` (case-insensitive, trim, prefer the ACTIVE row) to a display name. Unresolved → `"Someone"` at render. A legacy note with `author = NULL` from the sc-9 backfill renders with no name.

**Grouping.** `groupHistory()` collapses a run of consecutive `actual_delete` entries by the same author within 2 seconds into one "Reset by <name>: N services cleared" line. A non-delete entry between two deletes, or a change of author, or a ≥ 2.001 s gap, breaks the group.

**Adding a note.** `POST /api/service/day-note` with `{ accountKey, serviceDate, note }`. Gate order: `requireOwnerApi()` → `canWriteForAccount` → insert. The author is the signed-in session email; the client cannot spoof it. No period lock, no week lock — sc-25 is explicit: "Notes stay open on a locked period." The response carries the fresh loader payload so the fold updates in place without a reload.

**Companion system notes** (written server-side, log-and-continue on failure, author = signed-in session email, `source = null`):

- `DELETE /api/service/day-actuals` (the drawer's "Back to projections") → inserts `"Cleared back to projections"` after the delete succeeds.
- `POST /api/service/day-actuals` that leaves every actual at 0 for the day → inserts `"Marked not served"` after the save.

Nothing in this surface writes to `sc_daily_actuals_history` directly — that table is driver-trigger-only.

### Carry-ins from train 3

1. **Push to QuickBooks again.** On the week check's headline (not the calendar band). Renders only when the page's finalize row has `submitted_via = 'v2' AND push_gave_up_at IS NOT NULL`. Gated by `canPushAgainDb()` in `src/lib/sc/submit/pushAgainScope.ts`: the three people with `is_sc_lock_override = true` on an ACTIVE `people` row (case-insensitive, trim, any-row), AND `SC_V2_OUTBOUND != "off"`. Route: `POST /api/service/push-again { rowId }` → delegates to `pushAgain(rowId)` in `src/lib/sc/submit/push.ts` which already enforces not_v2 / already_done / not_given_up / reverted / race_lost refusals.
2. **`review.css` raw pixels** move to file-local tokens prefixed `--kf-sc-rv-*` (scoped to `:root` because the pinned foot sits outside `.kf-sc-rv-surface`): `--kf-sc-rv-foot: 80px`, `--kf-sc-rv-foot-phone: 110px`, `--kf-sc-rv-dl-p: 150px`, `--kf-sc-rv-dl-a: 118px`, `--kf-sc-rv-dl-q: 72px`, `--kf-sc-rv-dl-cell-y: var(--sp-sp-1)`. Every raw `4px` and `6px` swaps to `var(--sp-sp-1)` where applicable.
3. **No-day-record message** rewrites in `src/lib/sc/submit/dayFixFlag.ts` to: "That day has no record yet. Enter it from the calendar first."
4. **Back to projections hit area.** The button is a plain `.kf-btn.kf-btn--line` inside `.kf-sc-dr__acts`; the shared `.kf-btn` base already carries `min-height: var(--sp-floor-chef)` (48 px) and there is no absolute element above it inside the drawer. The remote-click miss on Nov 17 would not reproduce with this markup; a Playwright assertion is queued with the `tests/.auth/user.json` refresh.

### Files

**New:** `src/lib/sc/calendar/isAskedYet.ts`, `src/lib/sc/sitesBoard/{types,bucket,load}.ts`, `src/components/service/sitesBoard/SitesBoard.tsx`, `src/lib/sc/mlb/{types,gameMark,homeStands,load}.ts`, `src/app/(shell)/service/mlb/{page.tsx,mlb.css}`, `src/components/service/mlb/BigLeagueCalendar.tsx`, `src/lib/sc/notesHistory/{types,formatHistoryLine,load}.ts`, `src/components/service/drawer/NotesAndHistory.tsx`, `src/app/api/service/day-note/route.ts`, `src/lib/sc/submit/pushAgainScope.ts`, `src/app/api/service/push-again/route.ts`. Tests in each module's `__tests__/`.

**Changed:** `src/app/(shell)/service/page.tsx` (no-site branch renders `SitesBoard`, plus loads MLB accounts; retires `SiteList`), `src/app/(shell)/service/service.css` (adds `.kf-sc-sites*`, `.kf-sc-site*`, `.kf-sc-mark`, `.kf-sc-mini*`, `.kf-sc-seg a`, `.kf-sc-region`, `.kf-sc-legend--mini`, `.kf-sc-notebox`, `.kf-sc-fold`, `.kf-sc-ledger*`), `src/app/(shell)/service/review/review.css` (file-local tokens + raw-pixel sweep + `.kf-sc-rv-pushfail`), `src/components/service/review/ReviewPage.tsx` (push-again headline + handler + `canPushAgain` prop), `src/app/(shell)/service/review/page.tsx` (server-side push-again scope), `src/lib/sc/submit/reviewLoader.ts` (carries `finalizeRowId`, `submittedVia`, `pushGaveUp`), `src/components/service/DayDrawer.tsx` (mounts `NotesAndHistory`), `src/app/api/service/day-actuals/route.ts` (companion system notes on DELETE + allZero POST), `src/lib/sc/submit/dayFixFlag.ts` (no-day-record copy).

**Removed:** `src/components/service/SiteList.tsx` (stand-in, retired by `SitesBoard`).

**Not touched:** `src/app/tokens.css`, `src/app/components.css`, `src/components/shell/**`, `src/lib/fmt.ts`, `src/app/globals.css`, `package.json`, `vercel.json`, `docs/DESIGN.md`, `docs/GOTCHAS.md`, `docs/GOVERNANCE.md`, `docs/OWNERSHIP.md`. One shared file touched by convention: `docs/LEDGER.md` carries the one-line pointer.

### Tests

Four new test files, 44 cases (all pass): `isAskedYet` (nine branches + cutover boundary), `bucket.classifyRow` (twelve kinds + override), `gameMark` (four `day_type` values + three time-zone cases + the null-input branch), `homeStands` (five cases including the mode-switch), `formatHistoryLine` (eleven cases including the 2-second boundary in both directions).

`package.json` is a shared file and I did not touch it; the `test:sc` script's glob still only matches `src/lib/sc/billing/**`. A one-line glob extension (e.g. `'src/lib/sc/**/__tests__/*.test.mjs'`) belongs to the shared-foundation lane — flagged in the PR body.

## Train 1 - the billing engine moves (2026-11-15)

v1's billing engine at commit `c3c1b902` is copied into `src/lib/sc/**` with its tests. Nothing in V2 calls the engine yet. No screen, no route, no scheduled job. Rule changes belong to train 2.

The promise: correct billing amounts. Logic is v1 verbatim; comments carry the rulings.

## What was copied, from which commit

Source of truth: `kitchfix-intranet` at `c3c1b902` (checked out at `~/dev/kf-sc-v2-read`, detached HEAD). Everything below lands under `src/lib/sc/`:

**Engine sources (16 files, 4,185 + 1,364 = 5,549 lines of logic):**

| v1 | v2 |
|---|---|
| `src/lib/billing/billableTotal.js` (49 lines) | `src/lib/sc/billing/billableTotal.ts` |
| `src/lib/billing/buildInvoicePayload.js` (525) | `src/lib/sc/billing/buildInvoicePayload.ts` |
| `src/lib/billing/chaseNotifications.js` (387) | `src/lib/sc/billing/chaseNotifications.ts` |
| `src/lib/billing/chasePersonName.js` (111) | `src/lib/sc/billing/chasePersonName.ts` |
| `src/lib/billing/getSalariedManagerEmails.js` (97) | `src/lib/sc/billing/getSalariedManagerEmails.ts` |
| `src/lib/billing/invoiceMemo.js` (91) | `src/lib/sc/billing/invoiceMemo.ts` |
| `src/lib/billing/pfsLogoBase64.js` (17) | `src/lib/sc/billing/pfsLogoBase64.ts` |
| `src/lib/billing/qboAdapter.js` (1,145) | `src/lib/sc/billing/qboAdapter.ts` |
| `src/lib/billing/qboMode.js` (101) | `src/lib/sc/billing/qboMode.ts` |
| `src/lib/billing/qboNotifications.js` (822) | `src/lib/sc/billing/qboNotifications.ts` |
| `src/lib/billing/recipients.js` (245) | `src/lib/sc/billing/recipients.ts` |
| `src/lib/billing/recordCopyPdf.js` (543) | `src/lib/sc/billing/recordCopyPdf.ts` |
| `src/lib/billing/variance.js` (52) | `src/lib/sc/billing/variance.ts` |
| `src/lib/scWeekFinalize.js` (1,089) | `src/lib/sc/scWeekFinalize.ts` |
| `src/lib/scPeriodLock.js` (97) | `src/lib/sc/scPeriodLock.ts` |
| `src/lib/scReviewState.js` (178) | `src/lib/sc/scReviewState.ts` |

**Tests (12 files + 2 helpers, byte-for-byte):**

| v1 | v2 |
|---|---|
| `src/lib/billing/__tests__/_helpers.mjs` (helper) | same path under `src/lib/sc/` |
| `src/lib/billing/__tests__/_supa-mock.mjs` (helper) | same |
| `src/lib/billing/__tests__/_supa-mock.test.mjs` | same |
| `src/lib/billing/__tests__/checkLiveInvoiceForRevert.test.mjs` | same |
| `src/lib/billing/__tests__/negative.test.mjs` | same |
| `src/lib/billing/__tests__/parity.test.mjs` | same |
| `src/lib/billing/__tests__/qboAdapter.test.mjs` | same |
| `src/lib/billing/__tests__/qboInvoiceFields.test.mjs` | same |
| `src/lib/billing/__tests__/qboNotifications.test.mjs` | same |
| `src/lib/billing/__tests__/recipients.test.mjs` | same |
| `src/lib/billing/__tests__/runFinalizeEffects.test.mjs` | same |
| `src/lib/billing/__tests__/sc58-pretax-reconcile.test.mjs` | same |
| `src/lib/billing/recordCopyPdf.test.mjs` | `src/lib/sc/billing/recordCopyPdf.test.mjs` |
| `src/lib/billing/variance.test.js` | `src/lib/sc/billing/variance.test.mjs` (renamed - package has no `"type": "module"`, a `.js` test file would fail with `Cannot find module './variance.js'` under V2's loader) |

**Fixtures (4 JSON files, byte-for-byte):**

`src/lib/billing/__fixtures__/qbo_K300168897_txr_wk_0720.json`,
`qbo_K300168899_cin_pair_0713_main.json`,
`qbo_K300168900_cin_pair_0713_rehab.json`,
`qbo_K300168954_txr_wk_0727.json` - all under `src/lib/sc/billing/__fixtures__/`.

**Not moved in train 1** (by Kevin's answers to step 0, questions 1-2):
- `src/app/service-calendar/v2/billing/perMealAccounts.js` - a gate its callers apply (screen, main SC route, chase cron), not part of the engine. Comes with the train that brings a caller.
- `src/app/api/cron/sc-chase/isWeekFullyEntered.js` - belongs to the chase cron; the reminders are being redesigned.

## How to run the tests

```
npm run test:sc
```

Script in `package.json`:

```
"test:sc": "node --import tsx --test 'src/lib/sc/billing/__tests__/*.test.mjs' 'src/lib/sc/billing/*.test.mjs'"
```

No `.env.local` is loaded. The tests pass with an empty environment (measured: all 191 pass with every variable unset).

On Node v24.13.1, the engine runs 191 tests across 9 suites in ~2.3s. 191 pass, 0 fail, 0 skipped.

## The three lane seams

The engine imports only five things from outside itself: `@/lib/supabase` (service client), `@/lib/admin` (one function), `@/lib/gmail` (one function, also as `../gmail.js`), `pdf-lib`, `node:crypto`. The first three are shimmed by three lane-local files. `pdf-lib` and `node:crypto` are unchanged.

### `src/lib/sc/_seams.ts` - Supabase

Re-exports v2's `serviceClient` (in `src/lib/supabase/service.ts`) under v1's name `getServiceClient`. Engine files change only their import path. v1's client is per-call; v2's is cached for the process; both have session persistence off, service role, same `SupabaseClient` shape. The engine never holds more than one at a time, so the two caching strategies are interchangeable here.

### `src/lib/sc/admin.ts` - Lock override

One export: `isScLockOverrideDb(email): Promise<boolean>`. True when the `people` table has any row for that lower-cased, trimmed work email with `is_sc_lock_override = true`. False for no email, no matching row, or any failure, including a database client that cannot be built (it logs one `console.error` line, without the address). It never throws.

Why "any row": nine work emails sit on more than one `people` row today (22 rows: one row per hire, each with its own `worker_id`). `.maybeSingle()` would error on those. We use `.eq("work_email", e).eq("is_sc_lock_override", true).limit(1)` and check for any returned row.

Why `.eq` not `.ilike`: `_` is a wildcard in `ilike` and a legal character in an email. Exact match on the lower-cased, trimmed address is the only safe comparator.

No hardcoded email list for the lock override. No write to `admin_drift_log`.

The engine's recipient rules still name work addresses in code, copied as they are from v1: `billing/recipients.ts`, `billing/qboNotifications.ts` and `billing/chaseNotifications.ts`. Whether those move to data is a train 2 question.

### `src/lib/sc/outbound.ts` - the one door out

Two exports, both inert in train 1:

- `sendEmailSA(args): Promise<"sent" | "failed">` - matches v1's contract (v1's returns the literal string `"sent"` or `"failed"` and never throws). The stub logs one `console.error` line and resolves `"failed"`.
- `networkFetch(input, init?): Promise<Response>` - fetch-shaped. The stub logs one `console.error` line and rejects, matching what `fetch` does when the network is down. Every call site in the engine (two in `qboAdapter`'s `doPost`/`doGetCustomer`, one in `qboNotifications`'s `sendSlack`, one in `scReviewState`'s `alertReviewClearFailure`) already catches.

This file is the only one under `src/lib/sc/**` that may touch the outside world. Train 2 wires the real senders.

## Environment variables the engine reads

Seven names (names only, no values). Train 1 adds none to Vercel or to any `.env*` file. The tests pass with every one unset. Five of the twelve read sites take an injected value first; the other seven read the variable directly or first.

| name | files that read it |
|---|---|
| `SLACK_SC_BILLING_WEBHOOK_URL` | `billing/chaseNotifications.ts`, `billing/qboNotifications.ts`, `scReviewState.ts` |
| `QBO_PROXY_BASE` | `billing/qboAdapter.ts` |
| `QBO_PROXY_KEY` | `billing/qboAdapter.ts` |
| `QBO_REALM_ID` | `billing/qboAdapter.ts` |
| `NEXT_PUBLIC_APP_BASE_URL` | `scWeekFinalize.ts` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `billing/qboNotifications.ts` (presence check only, in `verifyGmailEnv()`) |
| `GOOGLE_PRIVATE_KEY` | `billing/qboNotifications.ts` (presence check only) |

## Database tables and functions the engine touches

Read from the code with a syntax-tree scan on 2026-11-15, and from the database for the view. Nothing in V2 calls the engine in train 1, so none of this runs yet.

| table | read in | written in |
|---|---|---|
| `accounts` | `scWeekFinalize.ts` | - |
| `contacts` | `scWeekFinalize.ts` | - |
| `people` | `admin.ts`, `billing/chasePersonName.ts`, `billing/getSalariedManagerEmails.ts` | - |
| `sc_daily_actuals` | `billing/chasePersonName.ts`, `scWeekFinalize.ts` | - |
| `sc_daily_projections` | `scWeekFinalize.ts` | - |
| `sc_daily_revenue` (a view) | `scWeekFinalize.ts` | - |
| `sc_day_metadata` | `scReviewState.ts`, `scWeekFinalize.ts` | `scReviewState.ts`: update, clears `review_status`, `reviewed_by`, `reviewed_at` |
| `sc_export_ledger` | `billing/qboAdapter.ts`, `scWeekFinalize.ts` | `billing/qboAdapter.ts`: insert |
| `sc_invoice_slot_codes` | `scWeekFinalize.ts` | - |
| `sc_qbo_account_map` | `scWeekFinalize.ts` | - |
| `sc_qbo_service_map` | `scWeekFinalize.ts` | - |
| `sc_week_finalize` | `scWeekFinalize.ts` | `scWeekFinalize.ts`: update, sets `status` to `push_failed` |

Database functions:

- `sc_is_day_locked` - called in `scPeriodLock.ts`.
- `nextval_sc_invoice_test_number` - called in `billing/qboAdapter.ts`, for test invoice numbers only. It advances the sequence `sc_invoice_test_number_seq`.

The engine does not read `sc_fee_schedule`. Prices reach it through the view `sc_daily_revenue`, which reads `sc_daily_actuals`, `sc_daily_projections`, `sc_day_metadata`, `sc_service_groups`, `sc_service_prices` and `sc_services`.

## The submit library (train 2 part two-B, 2026-11-16)

The engine can build and push an invoice. Train 2 part two-B adds what sits in front of that: the rules for who may submit a week, the checks before anything is locked, the lock itself, and a push to QuickBooks that retries on its own. It is a library under `src/lib/sc/submit/**`. No route, no page, no scheduled job, no `vercel.json` entry; those are thin wrappers that ship with the first screen.

**Six exported functions, plus the migration record.**

- `canSubmitForAccount(email, accountKey, supa?)` - may this address submit for this site? True when any ACTIVE `people` row for the address is corporate, OR a regional director whose `region` equals the account's region, OR salaried at the account.
- `checkWeekSubmittable(args, supa?)` - every reason the week cannot be submitted, in nine codes: `NOT_AUTHORIZED`, `ALREADY_SUBMITTED`, `WEEK_IN_FUTURE`, `NOT_CLOSING_WEEK` (biweekly first-week refused), `WEEK_LABEL_MISSING` (biweekly with no label on the Monday), `PERIOD_LOCKED`, `DAY_FLAGGED`, `PROJECTION_UNENTERED`, `UNPRICED_LINES` (billed sites only). An empty list means the lock may write.
- `submitWeek(args, supa?)` - runs the checks and, if the list is empty, writes one row into `sc_week_finalize`. A billed site gets `push_next_try_at=now()`; a non-billed site is done at once (`push_done_at=now()`, no next try). A unique-index refusal is treated as `ALREADY_SUBMITTED`, not an error.
- `attemptPushForRow(rowId, deps?)`, `findAndAttemptDuePushRows(deps?)`, `pushAgain(rowId, supa?)` - the push, with retries. Every 10 minutes, six tries in all, then Kevin and Sebastian are told through the engine's existing failure notice. Not before. Only rows marked `submitted_via='v2'` are touched. `pushAgain` resets a given-up row to a fresh six-try run; it refuses rows that are not v2, reverted, already done, or not given up.

**The row's life.**

| Event | status | submitted_via | push_attempts | push_next_try_at | push_done_at | push_gave_up_at | push_last_error |
|---|---|---|---|---|---|---|---|
| Submit (billed site) | finalized | 'v2' | 0 | now | null | null | null |
| Submit (non-billed site) | finalized | 'v2' | 0 | null | now | null | null |
| Fail on tries 1-5 | push_failed | 'v2' | 1..5 | now + 10 min | null | null | error |
| Success on any try | finalized | 'v2' | N | null | now | null | null |
| Give up (attempt 6) | push_failed | 'v2' | 6 | null | null | now | error |
| Push again | push_failed | 'v2' | 0 | now | null | null | null |

No V2 path writes `status='billed'`. v1 uses that word to mean "cannot be reverted"; V2 success stays `finalized` and is told apart by `push_done_at`. "It succeeded" is told by the timestamp, not the status word.

**The claim.** A compare-and-swap through supabase-js (no raw SQL, no new database function): read the row (push_attempts = n), then UPDATE with new values filtered on `id`, `submitted_via='v2'`, `push_attempts=n`, `push_next_try_at <= now`, `push_done_at IS NULL`, `push_gave_up_at IS NULL`, `status <> 'reverted'`, and ask for the row back. Postgres re-checks under the row lock, so two runs cannot both win. The lease is 20 minutes - if a worker dies mid-attempt, the counter is one above where it was and the row is unclaimable for 20 minutes; after that, attempt N+1 runs and attempt N is a lost completion write.

**On a throw at the sixth try, the submit layer fires the failure notice itself.** The engine's `runFinalizeEffects` throws on a database read error before its own `fireN2` has a chance to run. On tries 1 through 5 the submit layer swallows that thrown error silently and schedules the next try; on try 6 it calls `fireN2` once with the row's account, week and the truncated error text. A notice that itself fails is caught, logged without the address, and still leaves the give-up write in place. On a returned failure (the engine caught the inner post error and reported it) the engine already fired `fireN2` during the attempt, so the submit layer does nothing extra - the once-only discipline is observed on both paths.

**`weekStart` must be a Monday.** Both `checkWeekSubmittable` and `submitWeek` throw if `weekStart` is not `YYYY-MM-DD` or does not equal `mondayOfWeek(weekStart)`. A non-Monday weekStart would make the span start on the wrong day and let two live rows for the same real week coexist (the unique index keys on the Monday; the engine's `loadLiveFinalizeRow` also keys on the Monday). It is a caller's mistake, not a reason to show a site, so it throws instead of returning a tenth block code.

**v1 is the fallback.** This PR adds files only (plus the optional `supaArg` on `assertDaysUnlockedForWrite` for test injection, matching the pattern added to `isScLockOverrideDb` in part 2-A). v1's reminder job, calendar route and engine still read `sc_week_finalize` and continue to work. The 47 rows v1 made carry `submitted_via` null and are never touched by the V2 retry loop.

**What is NOT built yet (comes with the first screen).**

- No route exposing `submitWeek` / `checkWeekSubmittable`.
- No scheduled job calling `findAndAttemptDuePushRows`.
- No changes to `vercel.json`.
- No real email / Slack / QuickBooks traffic from V2 - outbound stays inert in train 2.

`requireAllDaysApproved` stays in `scReviewState.ts` unchanged and unused by the submit path (per the brief: no per-day approval is required).

## The day form and its save (train 2, 2026-11-17)

The first V2 screen that writes to the database. A site leader opens one day from the calendar (`/service?site=...&day=YYYY-MM-DD`), enters the actuals for each service, and saves. Save is the only thing that writes.

**Owner-only today.** `requireOwnerPage()` gates the drawer page; `requireOwnerApi()` gates the write route. Once the staff sign-in switch opens, the write path's scope check (`canWriteForAccount`) takes over - corp writes for every account, salaried for their own, no region check (Kevin ruling 2026-11-17 2.B). The regional-director case is intentional: directors carry `is_corp=true`, so they inherit the corporate grant.

**Open by URL (rule 17).** The drawer is `?day=<ISO>` on `/service`; Back closes it. What is typed and not saved lives in `localStorage` (keys `kf-sc-drafts-v2` + `kf-sc-kept-v2`), per-device, scoped to `(accountKey, serviceDate)`. Re-opening the day offers Keep them / Clear them. No "leave without saving?" prompt anywhere. Private-mode-safe: every read + write wraps in try/catch with a session-scoped memory fallback.

**The write route.** `POST /api/service/day-actuals` (upsert touched entries) and `DELETE /api/service/day-actuals` (clear-to-projections). Gate order for both: owner → `canWriteForAccount` → `coerceActualCount` (POST only) → `assertDaysUnlockedForWrite` → `assertWeekOpenForWrite` → day-token recheck → write → `clearReviewStateForDays` (non-fatal) → recompute token + state via the shared `resolveDayState` so the save and the calendar cannot disagree on the post-save word.

**The day-level concurrency token (Kevin ruling 1.A).** SHA-256 of the sorted `(service_id, actual_count, updated_at)` rows for the day, hex-encoded, first 16 chars. The drawer-open side builds it from the loader's rows; the save side recomputes from current rows. Mismatch → 409 `DAY_CHANGED` with the full current rows for a Keep theirs / Save mine panel. "Save mine" resends with `acceptClash: true`; the locks and scope run again, only the token check is suppressed. Empty-day TOCTOU: a narrow race where two unentered-day saves land simultaneously can duplicate the first winner's values into the second's write; the unique index makes that harmless and the trigger records the change on reload.

**Rule 16 (slipped digit).** Client-side only. On Save, a non-flat-fee line at ≥ 3× its projection asks once in place - "<service> is 900. The projection was 90. Keep 900?" Keep / Change it. Keeping writes `(accountKey, serviceDate, serviceId, value)` to the kept store so the same number never asks twice. Server does not see this store.

**Rule 18 (two people).** Day-level: any concurrent save on the same `(account, date)` trips the clash, even on a different service. False-positive cost is low per site; the benefit is no silent overwrite.

**Rule 19 (meals counts meals).** The running total under the input list adds only lines whose service unit is `meals` and is not flat-fee. Pans, each, days and dollars count as rows on the day, not meals.

**F2 post-save focus.** After a successful save the drawer advances to the next day in the same Monday-Sunday week that still has projections not fully answered - the moved drawer shows "Saved Tuesday. Now Wednesday, Nov 18." in its head. When no such day remains, the drawer closes to the calendar.

**Clear-to-projections (Kevin ruling 3.A).** The drawer's "Back to projections" button sends a DELETE. The route runs both locks and the token check, then DELETEs every actuals row for the day; the BEFORE DELETE trigger writes `change_type='delete'` receipts in `sc_daily_actuals_history`. The optional audit note to `sc_day_note_entries` is deferred - the notes surface is not built in V2 yet, so the note-write is held with the ledger UI as a follow-up.

**Files added in this train.** The shared `canWriteForAccount` helper, the `dayActuals` lib (`types`, `coerceActualCount`, `dayToken`, `saveActuals`, `loadDrawer`), the `POST`/`DELETE` route, the `DayDrawer` client + `dayDraftStore`, and 15 new tests (`dayActuals-coerce`, `dayActuals-token`, `dayActuals-canwrite`).

**Not yet verified live.** Owner-only on production today, same as train 1. The interactive flows (slipped-digit, clash, drafts) are unit-tested; the live rule-18 clash and the two-person case cannot be exercised until staff sign-in is opened. The audit note on reset / not-served is held pending Kevin's ruling.

## The calendar home screen - train 1b fit (2026-11-16)

Train 1 (PR #61) is live. Train 1b is a fit-only pass against the live measurement Chat-Claude took at 18 widths that night. **No change to the read model's rules except one, named at the bottom of this section.**

**Type scale.** Five sizes on the whole screen, including the shared band's 30px: 13px (small text everywhere), 16px (phone h1, week-row dates, site-list headings, empty-state titles), 20px (period + year-section titles, year-card period letter, phone day-row number), 28px (the day's number in a wide cell, display face, tabular). `--sp-t-micro` (12px) is not used on this surface; the smallest text is 13px.

**Short-screen fold.** On a wide viewport under 1200px tall, a finished week above the current week folds to a 58px line (dates + sub-line + state + a "Show the days" toggle). On a viewport at 1200px tall or more the toggle is not drawn and every week shows its days. The toggle reads "Show the days" or "Hide the days" and carries `aria-expanded`. The threshold moved from 959 to 1199 on 2026-11-17 so laptops up to 1680x1050 fold their finished weeks and keep this-week visible above the fold.

**Colour key.** The ring of coloured squares with their names ("Submitted / Entered / Projected / Needs actuals / No service / Today") renders only on viewports at least 1200px tall and wider than a phone. On short desks and phones the key hides: each cell carries its state word in full, and the cell's ground colour is the second signal.

**Phone layout.** At viewport ≤ 860px wide the surface rebuilds: the period header is one line (title + Now + dates + arrows); a "What the colours mean" fold does not render on this surface - the cell grounds carry the colour; this week is open as seven 56px rows (dow + date, number, state, home-game adds one more line below); every other week sits folded as a 56px line; the year sits behind one line ("Show the year").

**What read wrong before.**

- The small coloured square at the top of each day cell is gone - it looked like an empty tick box. The cell's ground + the state's icon and word carry the state. Squares still sit in the colour key and in the year's small grids.
- Chips never wrap: `.kf-sc-chip` has `white-space: nowrap`. Week dates stay on one line at every width from 360 to 1920.
- Today reads as the navy "Today" chip next to the date in a wide cell, with a ring on the cell. It does not squeeze the date onto a second line.
- The site-list uses only the band's heading; the "Open a calendar" + "Pick a site." lines are gone.
- A site with no `sc_qbo_account_map` row carries "Not billed through the service calendar." as one plain line near the period header, on every period, wide and narrow.

**Rule change.** `src/lib/sc/calendar/load.ts` now counts a day in the year's "days entered" total when the day has any actuals line above zero - not only a meal line. A day with only non-meal lines (pans, each, days) counts; a not-served day (every projected line answered with 0) does not. A site that logged days with only non-meal lines will read a slightly higher days-entered total than before. `calendar-year-entered.test.mjs` covers the three branches. This is the only rule change in this train.

## The calendar home screen (train 1, 2026-11-16)

`/service` stops being the reserved door. It is the Service Calendar's home for one site: the current fiscal period as four weeks of seven days, each day with its meal number and its state in a word, each week with what it comes to and where it stands, and the thirteen periods of the year underneath. It reads the live database. **It writes nothing.** The day form comes in train 2 and the week check and submit in train 3; this is the read side they will both stand on.

Owner-only (`requireOwnerPage()`). The People lane's `resolveViewer` is reused as-is - no second resolver - and `?as=<worker_id>` previews work through the same path.

**Who sees which sites.** Three paths, in this order (the two regional directors on file carry `is_corp` too, and the order is load-bearing):

1. `is_regional_director` -> every calendar account in `accounts.region = viewer.region`, and only those.
2. `is_corp` -> every calendar account.
3. `is_salaried` -> the viewer's own account.

Anything else: the no-access state. A calendar account for this train is active, has at least one active service, and its `level` is not `MLB` (the four big league clubhouses get their own simple calendar later).

**Address.** `/service?site=<slug>&fy=<year>&p=<period>&as=<worker_id>`. The slug is the account key lower-cased with ` - ` as `-` (`TBR - FL` is `tbr-fl`). No `site`: a viewer with one site lands on it; a viewer with several gets a plain list of their sites, by region. A `site` the viewer does not have: `notFound()`. No `fy` or `p`: the fiscal period that holds the site's own today, read from `sc_site_today(p_account_key)`.

**Where the rules live (`src/lib/sc/calendar/**`).** Pure functions in their own files, plus one loader:

- `types.ts` - `DayStateCode`, `WeekStateCode`, `DayView`, `WeekView`, `PeriodView`, `YearPeriodCard`, `CalendarView`. `WeekView` carries `submittedAt` (a timestamptz) but no `submittedBy`: `sc_week_finalize.finalized_by` is a work email and no address leaves the server.
- `dayState.ts` - `resolveDayState(input)` -> the day's word, tone and icon. Pin 7, first-match-wins, nine codes.
- `weekState.ts` - `resolveWeekState(input)` -> the week's word, tone and icon. Pin 8. The `push_failed` override reads `isCorpViewer`; non-corp viewers always see "Submitted".
- `billable.ts` - `shortDollarsFromCents(cents)` rounds to the nearest hundred and reads a dollar sign plus either a three-digit figure or an N-point-N kilo figure. The label "before tax" is added at the call site.
- `accessList.ts` - `visibleSites(viewer, calendarAccounts)` and `siteInfoFrom(acc, qboMap)`. The three-path order lives here.
- `slug.ts` - `accountKeyToSlug("TBR - FL") = "tbr-fl"` and `slugToAccountKey(slug, keys)` for the inverse.
- `periodWindow.ts` - 28-day Monday-first window from `fiscal_periods`, UTC-only arithmetic. A fiscal period that does not come out to 28 days throws.
- `inScopeAdapter.ts` - a thin supa-shape adapter. `resolveFinalizeReviewSpan(accountKey, weekStart, adapter)` serves its two reads from the already-loaded `sc_qbo_account_map` row and `sc_day_metadata` rows. Any other call shape throws loud so a shape change in the engine helper fails in tests before production.
- `load.ts` - the one loader. Ten round trips per page load.

**The ten round trips.** Every big read is bounded, and `sc_daily_revenue` is paged.

1. `rpc('sc_site_today', { p_account_key })`.
2. `fiscal_periods` for the fiscal year (13 rows).
3. `accounts` row for this site (name, region, level, timezone).
4. `sc_services` - every row the site has ever had, active or not, so a switched-off service still carries its unit (~20 rows).
5. `sc_qbo_account_map` - one row or none (not-billed site).
6. `sc_qbo_service_map` - the service ids this site excludes from export.
7. `sc_daily_revenue` over the fiscal year, **paged with `.range(start, end)`** ordered by `(service_date, service_id)`. The first page carries `{ count: 'exact' }`; the loader asserts that the number of rows it holds equals the count. A mismatch is thrown, never a silent short calendar. One site's fiscal 2026 can run past the 1000-row cap, so paging is load-bearing.
8. `sc_day_metadata` over the fiscal year (357 to 366 rows a site, one page - throws if it ever reaches the 1000-row cap).
9. `sc_week_finalize` over the fiscal year, `status <> 'reverted'`.
10. `rpc('sc_is_period_closed_fy', ...)` - one call per period, in parallel. There is no raw SQL path and no new database function.
11. `sc_phase_calendar` for this site (<= 48 rows total in the DB).

`resolveFinalizeReviewSpan` is called for every submitted row, through the in-memory adapter, so biweekly span resolution adds zero network trips.

**What the screen draws.** Approved preview, repo tokens and shared components only. Day cells are NOT buttons in this train: a day's reading (dow, date, number, state, home game) is in real text inside a list item (visually hidden where the visible parts do not already say it), so a screen reader meets every fact in order. The week row's fold toggle on narrow screens IS a button. Period step, "This period" and the 2026/2027 segmented control are 48px links. The band holds one headline built from data; **no button sits in the band this train** (nothing opens yet).

**Games, phases, and labels.**

- Home games on the calendar come from `sc_day_metadata.game_type` **when the value is `DAY` or `NIGHT`** and from Louisville and Buffalo only. The five complexes (`CIN - AZ`, `TXR - AZ`, `TBJ - FL`, `TBR - FL`, `STL - FL`) carry no `game_type` on any day and show no home-game mark here. The four big league clubhouses are not in this train.
- `game_type = 'OFF'` draws nothing. The day's state word already says what it is.
- `sc_day_metadata.event_label` is not drawn on a day cell. It is free text written by site users and sometimes spans multiple rows; a hover-only `title` is forbidden (DESIGN §11), and a chip would mislead.
- The camp phase comes from `sc_phase_calendar` (48 rows, the five complexes). It sits in the week column while the week is open; it is not read from `event_label`.
- **Not read in this train:** Dunedin and Palm Beach home games (they come from a schedule we do not touch yet). Their days render by state only. A follow-up train brings the schedule in.

**Tests (`calendar-*.test.mjs`, 40 new).** `calendar-dayState` (11), `calendar-weekState` (7), `calendar-accessList` (5 including an RD-flagged-corp case), `calendar-slug` (3), `calendar-billable` (5), `calendar-load-paging` (2), `calendar-adapter-parity` (7).

## What V2 changed from v1

Four rule changes land in train 2 part two-A, ruled by Kevin on 2026-11-16.

1. **A billed line with no price - or a price of 0 - stops the invoice and names which service and which day.** V1 and train 2 part one billed the line at 0 in silence. The new pure `findUnpricedBillableLines(rows, serviceMap)` in `src/lib/sc/billing/buildInvoicePayload.ts` is the one source of truth for the rule; the builder calls it before any invoice is produced and throws `UnpricedLinesError` with the full list. `runFinalizeEffects` reports the outcome as failure code `"UNPRICED_LINES"`, with the list on the failure object, through the same path `BUILD_ERROR` takes. A row with no service mapping is skipped by the pure function; the builder's existing "unmapped service" throw continues to cover that case with its own more specific message.
2. **The lock override needs an active person.** `isScLockOverrideDb` adds `.eq("status", "ACTIVE")` to the `people` query. A flag on a `TERMINATED` row no longer unlocks a period. Everything else about the function stays: lower-case and trim, exact match, any row, never throws.
3. **The account label is read from the column that exists.** `scWeekFinalize.ts` now selects `accounts.name` on `team_key`, not `team_name`. The `AccountRow` type in `src/lib/sc/types.ts` follows. The lookup stays soft: a miss falls back to `null` as before.
4. **The "approved by" names reach the email and the record copy.** `computeApproverPhrase` in `src/lib/sc/billing/recordCopyPdf.ts` now reads both snake_case (`reviewed_by`, `reviewed_at`) and camelCase (`reviewedBy`, `reviewedAt`). The real finalize path hands rows in snake_case from the `sc_day_metadata` select; existing fireN1 tests hand them in camelCase. Both are legitimate per the ruling.

## Type debt (measured, 2026-11-16)

Every exported function carries a real parameter type and a real return type. No `any` in any signature, no `any` inside any type a signature names. Row types in `src/lib/sc/types.ts` are keyed to the live schema.

Counted from the syntax tree by Chat-Claude's `sc_engine_type_debt.mjs`, not by text search:

| file | lines | `any` | casts | `as const` | `!` | `@ts-expect-error` | `declare` fields |
|---|--:|--:|--:|--:|--:|--:|--:|
| _seams.ts | 14 | 0 | 0 | 0 | 0 | 0 | 0 |
| admin.ts | 53 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/billableTotal.ts | 54 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/buildInvoicePayload.ts | 644 | 22 | 0 | 0 | 3 | 1 | 0 |
| billing/chaseNotifications.ts | 414 | 14 | 1 | 0 | 0 | 0 | 0 |
| billing/chasePersonName.ts | 120 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/getSalariedManagerEmails.ts | 113 | 0 | 0 | 0 | 2 | 0 | 0 |
| billing/invoiceMemo.ts | 93 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/pfsLogoBase64.ts | 17 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/qboAdapter.ts | 1213 | 41 | 2 | 0 | 1 | 0 | 12 |
| billing/qboMode.ts | 102 | 0 | 1 | 0 | 0 | 0 | 0 |
| billing/qboNotifications.ts | 928 | 30 | 0 | 1 | 0 | 0 | 0 |
| billing/recipients.ts | 266 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/recordCopyPdf.ts | 574 | 30 | 0 | 0 | 0 | 0 | 0 |
| billing/variance.ts | 54 | 0 | 0 | 0 | 0 | 0 | 0 |
| outbound.ts | 42 | 0 | 0 | 0 | 0 | 0 | 0 |
| scPeriodLock.ts | 102 | 0 | 0 | 0 | 0 | 0 | 0 |
| scReviewState.ts | 200 | 1 | 0 | 0 | 1 | 0 | 0 |
| scWeekFinalize.ts | 1171 | 18 | 1 | 0 | 0 | 0 | 0 |
| submit/canSubmit.ts | 77 | 0 | 0 | 0 | 0 | 0 | 0 |
| submit/checkSubmit.ts | 222 | 0 | 0 | 0 | 0 | 0 | 0 |
| submit/push.ts | 337 | 0 | 4 | 0 | 0 | 0 | 0 |
| submit/submit.ts | 112 | 0 | 1 | 0 | 0 | 0 | 0 |
| types.ts | 544 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Total** | 7466 | 156 | 10 | 1 | 7 | 1 | 12 |

Exported functions: 58. Every parameter typed for real: 58. Every parameter `any` or untyped: 0. Return type written: 58. Return type not written: 0.
Parameters on exported functions: 102, of which `any`: 0, untyped: 0.

### New `!` in this PR (3 added, 4 kept from train 1)

- `billing/getSalariedManagerEmails.ts` on `r.work_email!` inside `getSalariedManagerEmails` - `PersonManagerRow.work_email` is `string | null` because the column is nullable at the schema level; the query's `.not("work_email", "is", null)` filter ensures non-null at result level.
- `src/lib/sc/scReviewState.ts` on `read.rows!` inside `requireAllDaysApproved` - `rows` is optional in `readReviewStateForDays`'s return; the preceding `if (!read.success) return` guard guarantees it is set on the path that reads it.
- `billing/qboAdapter.ts` on `ctx.slotCode!` inside `postInvoiceDraft` - slotCode is optional on the ctx type because test-mode calls do not carry one; the live-mode branch is the only site that reads it, and the `isTest ? ... : ...` ternary guarantees the invariant.

The four non-null assertions carried from train 1 (every one on `rate!` after `roundToCent` in `billing/buildInvoicePayload.ts` and on `byAccount.get(r.account_key)!` in `billing/getSalariedManagerEmails.ts`) stay unchanged.

### New casts in this PR (1 logical cast, 2 AST nodes)

- `billing/qboAdapter.ts` at line 847, inside `postInvoiceDraft`: `stripInternalMarkers(marked) as unknown as QboInvoice`. `stripInternalMarkers` returns `Record<string, unknown> | null | undefined` because the destructuring strip throws away the two typed marker fields and TS loses the QBO shape. The cast asserts that every other QBO field stays in place on the stripped result, which is true by inspection of `stripInternalMarkers`'s body. Counts as one cast finding; two AST nodes because TS requires the double-step between non-overlapping object shapes.

The three casts carried from train 1 (`billing/chaseNotifications.ts` + `billing/qboMode.ts` on the `as Record<string, string>` object-literal index, `scWeekFinalize.ts` on `as any[]`) stay unchanged.

### New casts in train 2 part two-B (5)

All in `src/lib/sc/submit/**`. Each is on a value the Supabase client returns as `any` (the client is generic, not a typed-schema client) where the submit code knows the real row shape. Types-only; each erases to zero at runtime.

- `submit/push.ts:94` `beforeRaw as FinalizeRowWithRetry` on the pre-claim select.
- `submit/push.ts:129` `claimedRows[0] as FinalizeRowWithRetry` on the compare-and-swap's returning row.
- `submit/push.ts:168` `result.reason as "awaiting_pair_close" | "no_billable_actuals" | "already_invoiced"` - narrows the engine's `reason` string literal to the three finished-state codes the push layer answers.
- `submit/push.ts:310` `beforeRaw as Pick<FinalizeRowWithRetry, "submitted_via" | "status" | "push_done_at" | "push_gave_up_at">` on the pushAgain pre-flight read; the select names exactly those four columns.
- `submit/submit.ts:111` `inserted as FinalizeRowWithRetry` on the sc_week_finalize insert's returning row.

### `any` kept on code I touched (2)

Reducing these would require a change at run time, which the brief forbids:

- `src/lib/sc/scReviewState.ts` in `alertReviewClearFailure`'s catch block: `catch (e: any)`. Strict mode types a bare `catch (e)` as `unknown`; the two reads inside (`e?.message` and `String(e)`) then fail. V1's bare `catch (e)` runs as-is; keeping `e: any` is the one-token change that lets the two reads continue to work without adding an `instanceof Error` or `typeof === "string"` guard.
- `src/lib/sc/scPeriodLock.ts` arrow callback inside `.map`: `(d) => supa.rpc(...)`. The implicit `d` type is `any` because `new Set(dates)` resolves to `Set<any>` from the untyped `dates`. Annotating `d: string` would need `new Set<string>(dates)`, which is type-only, but adding the generic here would require the same discipline across every Set use in the engine - outside this PR's scope.

The 154 other `any` locations sit on code this PR did not modify: `catch (e: any)` blocks ported from v1, QBO payload-shape locals inside `qboAdapter.ts`, HTML-builder locals inside `qboNotifications.ts`, PDF-layout locals inside `recordCopyPdf.ts`. Reducing them is train 2 part two carry.

The one `@ts-expect-error` is in `billing/buildInvoicePayload.ts` on the date subtraction. v1's line is kept as it is.
The 12 `declare` fields are on the four error classes in `billing/qboAdapter.ts`. They emit nothing.

### Findings carried from train 2 part one

The two v1 bugs flagged by part one (accounts `team_name` lookup and the approver snake_case / camelCase mismatch) are fixed in part two-A, see "What V2 changed from v1" above.

The section below is the proof that nothing else from v1 drifted.

## What differs from v1 (measured, 2026-11-16)

Measured by Chat-Claude's `sc_engine_same_logic_check.mjs`: each V2 file has its types stripped and is compared with v1's file at `c3c1b902`, token by token.

- Import path strings: 30 (29 changed, 1 new).
- Other code tokens: 420. Train 2 part two-A took the number from 32 (train 2 part one baseline) to 414. Train 2 part two-B adds 6 more, all in `scPeriodLock.ts`, for the optional `supaArg?: SupabaseClient` parameter on `assertDaysUnlockedForWrite` plus the `supaArg || getServiceClient()` fallback at the call site. No other engine file moves. Every hunk belongs to one of the four rule changes (sc-60 through sc-63), the train 2 part one outbound seam / parentheses, or sc-64's optional supaArg.
  - `billing/buildInvoicePayload.ts`: 316 (sc-60 - `findUnpricedBillableLines`, `wouldProduceLine`, `UnpricedLine`, `UnpricedLinesError`, the guard call before the classify loop).
  - `scWeekFinalize.ts`: 41 in total: sc-60 adds the `UnpricedLinesError` import + `instanceof` branch + `FinalizeFailure` interface; sc-62 changes two string tokens on the `accounts.name` select.
  - `billing/recordCopyPdf.ts`: 25 (sc-63 - accept both `reviewedBy`/`reviewed_by` and `reviewedAt`/`reviewed_at`).
  - `scPeriodLock.ts`: 6 (sc-64 - `supaArg?: SupabaseClient` optional parameter + `supaArg || getServiceClient()` + pass-through to `isScLockOverrideDb(email, supaArg)`).
  - `billing/getSalariedManagerEmails.ts` 4, `billing/qboAdapter.ts` 10, `billing/qboNotifications.ts` 10, `scReviewState.ts` 8: unchanged from train 2 part one.
  - Every other file: 0.
- Comments: none of v1's lost or changed. 98 added since v1 (unchanged from part 2-A). Comments on the new submit files do not count here - they are additions, not edits to v1 engine files.
- Tests, helpers and fixtures: 18 of 18 byte for byte. The new test files in `src/lib/sc/billing/__tests__/` and the new helper `_supa-mock-submit.mjs` are additions, not edits.
