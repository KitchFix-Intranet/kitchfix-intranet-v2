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

## Type debt (measured, 2026-11-15)

The engine is TypeScript by file name and compiles under `strict`, but it is not typed yet. The step 0 answer asked for real parameter and return types on exported functions. That was not done in train 1. It is the first step of train 2, as a types-only PR, before any V2 code calls the engine.

Counted from the syntax tree by Chat-Claude's `sc_engine_type_debt.mjs`, not by text search:

| file | lines | `any` | casts | `as const` | `!` | `@ts-expect-error` | `declare` fields |
|---|--:|--:|--:|--:|--:|--:|--:|
| _seams.ts | 14 | 0 | 0 | 0 | 0 | 0 | 0 |
| admin.ts | 44 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/billableTotal.ts | 49 | 2 | 0 | 0 | 0 | 0 | 0 |
| billing/buildInvoicePayload.ts | 535 | 23 | 0 | 0 | 3 | 1 | 0 |
| billing/chaseNotifications.ts | 388 | 15 | 1 | 0 | 0 | 0 | 0 |
| billing/chasePersonName.ts | 113 | 2 | 0 | 0 | 0 | 0 | 0 |
| billing/getSalariedManagerEmails.ts | 101 | 6 | 0 | 0 | 1 | 0 | 0 |
| billing/invoiceMemo.ts | 91 | 6 | 0 | 0 | 0 | 0 | 0 |
| billing/pfsLogoBase64.ts | 17 | 0 | 0 | 0 | 0 | 0 | 0 |
| billing/qboAdapter.ts | 1161 | 64 | 0 | 0 | 0 | 0 | 12 |
| billing/qboMode.ts | 102 | 3 | 1 | 0 | 0 | 0 | 0 |
| billing/qboNotifications.ts | 825 | 35 | 0 | 1 | 0 | 0 | 0 |
| billing/recipients.ts | 245 | 2 | 0 | 0 | 0 | 0 | 0 |
| billing/recordCopyPdf.ts | 543 | 34 | 0 | 0 | 0 | 0 | 0 |
| billing/variance.ts | 52 | 1 | 0 | 0 | 0 | 0 | 0 |
| outbound.ts | 42 | 0 | 0 | 0 | 0 | 0 | 0 |
| scPeriodLock.ts | 97 | 3 | 0 | 0 | 0 | 0 | 0 |
| scReviewState.ts | 179 | 11 | 0 | 0 | 0 | 0 | 0 |
| scWeekFinalize.ts | 1089 | 34 | 1 | 0 | 0 | 0 | 0 |
| **Total** | 5687 | 241 | 3 | 1 | 4 | 1 | 12 |

Exported functions: 51. Every parameter typed for real: 3. Every parameter `any` or untyped: 48. Return type written: 3. Return type not written: 48.
Parameters on exported functions: 85, of which `any`: 80, untyped: 1.

- The one `@ts-expect-error` is in `billing/buildInvoicePayload.ts`, on the date subtraction. v1's line is kept as it is.
- The three casts, the four non-null assertions and their line numbers:
  - Every cast (not counting as const):
    - `billing/chaseNotifications.ts:326` - `as Record<string, string>`
    - `billing/qboMode.ts:101` - `as Record<string, string>`
    - `scWeekFinalize.ts:401` - `as any[]`
  - Every non-null assertion:
    - `billing/buildInvoicePayload.ts:378` - `rate!`
    - `billing/buildInvoicePayload.ts:393` - `rate!`
    - `billing/buildInvoicePayload.ts:438` - `rate!`
    - `billing/getSalariedManagerEmails.ts:98` - `byAccount.get(r.account_key)!`
- The 12 `declare` fields are on the four error classes in `billing/qboAdapter.ts`. They emit nothing.

None of this changes what runs. The section below is the proof.

## What differs from v1 (measured, 2026-11-15)

Measured by Chat-Claude's `sc_engine_same_logic_check.mjs`: each V2 file has its types stripped and is compared with v1's file at `c3c1b902`, token by token.

- Import path strings: 21 (19 changed, 2 new).
- Other code tokens: 32.
  - 22 are the outbound seam: two new import lines (`billing/qboAdapter.ts` and `scReviewState.ts`, 6 tokens each), `networkFetch` added to the existing import in `billing/qboNotifications.ts` (2 tokens), and four call sites where `fetch` became `networkFetch` (2 tokens each).
  - 10 are parentheses around five single arrow-function parameters, added so a type could be written: two in `billing/getSalariedManagerEmails.ts`, three in `billing/qboNotifications.ts`. `(r) => x` and `r => x` are the same function.
  - By file: `billing/getSalariedManagerEmails.ts` 4, `billing/qboAdapter.ts` 10, `billing/qboNotifications.ts` 10, `scReviewState.ts` 8. The other twelve files: 0.
- Comments: none of v1's lost or changed. 25 added, all about types.
- Tests, helpers and fixtures: 18 of 18 byte for byte.

A later types-only change must reproduce these numbers exactly.
