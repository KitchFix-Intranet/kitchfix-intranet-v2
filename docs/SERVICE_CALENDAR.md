# Service Calendar - Lane doc

Lane: Service Calendar (SC). This file is updated in the same PR as the SC work it describes.

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
