# KPI Dashboard - Lane doc

Lane: KPI Dashboard. This file is updated in the same PR as the KPI
work it describes.

## Train 2a - the overview calculation moves (2026-11-17)

v1's KPI screen gets its numbers from one data route,
`/api/kpi/overview`. This train moves the code behind that route out
of v1 and into V2 as `src/lib/kpi/**`, in TypeScript, with its logic
unchanged. No screen, no route, no scheduled job. Nothing calls it.
Nothing on the V2 site changes.

## Source of truth: the pin

v1's `main` at commit `c3c1b90260accfebe411c2c44416065351efc378`
(checked out at `~/dev/kf-kpi-readonly`, detached HEAD).

## What moved (36 files)

### 27 whole files, 14,422 lines

| v1 path (at the pin) | Lines | V2 path |
|---|--:|---|
| `src/app/kpi/labor/lib/board.js` | 1,016 | `src/lib/kpi/labor/board.ts` |
| `src/app/kpi/labor/lib/periods.js` | 400 | `src/lib/kpi/labor/periods.ts` |
| `src/app/kpi/purchasing/lib/board.js` | 1,166 | `src/lib/kpi/purchasing/board.ts` |
| `src/app/kpi/purchasing/lib/resolver.js` | 466 | `src/lib/kpi/purchasing/resolver.ts` |
| `src/lib/kpi/overview/accessFlags.js` | 57 | `src/lib/kpi/overview/accessFlags.ts` |
| `src/lib/kpi/overview/billback.js` | 405 | `src/lib/kpi/overview/billback.ts` |
| `src/lib/kpi/overview/budget-to-date.js` | 186 | `src/lib/kpi/overview/budget-to-date.ts` |
| `src/lib/kpi/overview/flags.js` | 108 | `src/lib/kpi/overview/flags.ts` |
| `src/lib/kpi/overview/formatting.js` | 194 | `src/lib/kpi/overview/formatting.ts` |
| `src/lib/kpi/overview/pnl-loader.js` | 526 | `src/lib/kpi/overview/pnl-loader.ts` |
| `src/lib/kpi/overview/resolver.js` | 4,591 | `src/lib/kpi/overview/resolver.ts` |
| `src/lib/kpi/overview/revenue-source.js` | 279 | `src/lib/kpi/overview/revenue-source.ts` |
| `src/lib/kpi/overview/ticker.js` | 247 | `src/lib/kpi/overview/ticker.ts` |
| `src/lib/kpi/previewAccess.js` | 161 | `src/lib/kpi/previewAccess.ts` |
| `src/lib/kpi/rangeSnap.js` | 148 | `src/lib/kpi/rangeSnap.ts` |
| `src/lib/kpi/resolveName.js` | 44 | `src/lib/kpi/resolveName.ts` |
| `src/lib/kpi/resolveWorkerMeta.js` | 87 | `src/lib/kpi/resolveWorkerMeta.ts` |
| `src/lib/kpi/shared/financeCloseAbsorb.js` | 206 | `src/lib/kpi/shared/financeCloseAbsorb.ts` |
| `src/lib/kpi/shared/financeCloseAdjustment.js` | 194 | `src/lib/kpi/shared/financeCloseAdjustment.ts` |
| `src/lib/kpi/shared/periodBasis.js` | 470 | `src/lib/kpi/shared/periodBasis.ts` |
| `src/lib/labor/labor-week-basis.js` | 738 | `src/lib/kpi/labor/labor-week-basis.ts` |
| `src/lib/labor/loaders.js` | 362 | `src/lib/kpi/labor/loaders.ts` |
| `src/lib/labor/personCount.js` | 84 | `src/lib/kpi/labor/personCount.ts` |
| `src/lib/labor/salaryBoard.js` | 446 | `src/lib/kpi/labor/salaryBoard.ts` |
| `src/lib/purchasing/glRollup.js` | 51 | `src/lib/kpi/purchasing/glRollup.ts` |
| `src/lib/purchasing/loaders.js` | 1,615 | `src/lib/kpi/purchasing/loaders.ts` |
| `src/lib/rippling/paginate.js` | 175 | `src/lib/kpi/shared/paginate.ts` |

### 3 partial files

- `src/lib/kpi/roleGate.js` → `src/lib/kpi/roleGate.ts`:
  only `canViewAccount`, `canSeeSalary`, `landingAccount`, as plain
  functions of a caller `{ role, scope, can_see_salary }`. Bodies
  unchanged. Reason for partial: v1's `resolveKpiRole` reads
  `kpi_roles`, `accounts`, `people` tables; `KPI_PREVIEW_ONLY` /
  `KPI_PREVIEW_ALLOWLIST` is a list of addresses. V2 gets the
  signed-in person from its own shared viewer in a later train.
- `src/lib/accountModels.js` → `src/lib/kpi/accountModels.ts`:
  only `costModelFor`, `isKnownAccount`, `PURCHASING_ENVELOPE_EXCLUSIONS`
  and the sets they depend on. Reason for partial: v1's
  `MANAGEMENT_FEE_GOALS` + `goalFor` carry dollar figures.
- `src/lib/rippling.js` → `src/lib/kpi/shared/rippling.ts`: only
  `isCardAuthorization`. The Rippling API client stays in v1.

### 5 files stay in v1

- `src/lib/auth.js`, `src/lib/supabase.js`: v1's sign-in and database
  client. V2 brings its own at the entry.
- `src/lib/analytics.js`: an empty stub.
- `src/lib/kpi/cacheHeaders.js`: HTTP only.
- `src/lib/incidentSchema.js`: addresses.

## The entry

`src/lib/kpi/entry.ts` exports `getOverview({ supa, today, caller,
query, regionalDirectorEastDisplay, regionalDirectorWestDisplay })`.
It is the engine's only public door in train 2a. It does what v1's
GET handler does from line 111 to line 298 of `route.js`, in the
same order, with the same outcomes (preview narrowing, no-account
landing, CORP refusal, not-authorised, salary gate, parseRange,
resolveOverview, preview_account / landing_account / export /
range_snap / todayISO). It returns `{ status, body }` as plain
data; no `NextResponse`, no headers.

It leaves out: the session, the preview-allowlist fence, the role
look-up, and the TEST_MODE / `_test_role` / `_test_scope` local
backdoor. The caller arrives as an input - that is what the
backdoor was standing in for.

## How to run the tests

```
npm run test:kpi
```

Script in `package.json`:

```
"test:kpi": "node --import tsx --test 'src/lib/kpi/__tests__/*.test.mjs'"
```

No `.env.local` is loaded; the tests pass with an empty environment
(they run on made-up inputs and the pure, DB-free functions only).

158 tests across three files:
- `board-draft-hours.test.mjs` (3): v1's own test, byte-for-byte
  apart from the import path.
- `twin-pure-functions.test.mjs` (150): one entry per made-up input
  per function, with the expected value captured from v1's own
  function at the pin by
  `src/lib/kpi/proof/_capture_v1_expected.mjs` (run in v1's
  worktree). Covers: `periods`, `rangeSnap`, `previewAccess`, the
  three access rules (`canViewAccount`, `canSeeSalary`,
  `landingAccount`), `purchasing/glRollup`, `overview/formatting`.
- `entry-early-answers.test.mjs` (5): the three early-answer
  branches (no account, CORP, not authorised) plus a null-caller
  safety case and an aggregate-refusal case. No database touched.

## How to run the same-answers proof

Local only. v1's own dev server on a spare port, with `TEST_MODE=true`
and `VERCEL` unset. Local-only, one request at a time, only
`GET /api/kpi/overview`.

```
# In v1's worktree (~/dev/kf-kpi-readonly):
TEST_MODE=true VERCEL='' node node_modules/.bin/next dev -p 3100

# In V2's worktree:
node --import tsx src/lib/kpi/proof/compare_answers.mjs \
     --env-file=/path/to/.env.local
```

The proof writes to `~/Downloads/KPI_V2_Handoff/proof_2a/`:
- `case/<idx>-<id>.json`: the redacted A + V + B for each case
- `fingerprints.json`: per-case sha256 + status
- `PROOF_REPORT.md`: counts, case names, field paths

Comparison: exact after sha256-redacting email + drive-url fields
and dropping `regional_directors_display` (item 3 in the brief).

## Same-code measure

```
node --import tsx src/lib/kpi/proof/same_code.mjs <v1-root>
```

For every row of the move mapping, it strips types from the V2 file,
drops comments + whitespace, and compares token by token with v1's
`.js` at the pin. Reports per-file: v1 tokens, differing tokens,
import-path vs other. Expected: 0 non-import diffs for every file
moved whole, except `overview/resolver.ts` (the few tokens for item
3).

## Type debt

See `KPI_ENGINE_2A_REPORT.md` for the per-file counts of `any`,
`as`, `!`, `@ts-expect-error`. Every one is a result of a type
narrowing TypeScript applies to v1's JS where the real shape is
wider; none is a behaviour change.

## Carried as v1 has them

Train 2a moves v1's engine without fixing anything. The items below
are measured and left for a later train.

- **The 2026 fiscal year, typed in (20 lines).** Train 2b.

  | v1 file (at the pin) | Lines |
  |---|---|
  | `src/app/kpi/labor/lib/periods.js` | 19, 20, 58 |
  | `src/lib/kpi/overview/pnl-loader.js` | 57, 133, 182, 233 |
  | `src/lib/kpi/overview/resolver.js` | 125, 263 |
  | `src/lib/kpi/shared/periodBasis.js` | 65 |
  | `src/lib/labor/labor-week-basis.js` | 56 |
  | `src/lib/labor/loaders.js` | 117, 118, 119, 200, 204, 205 |
  | `src/lib/labor/salaryBoard.js` | 51, 116 |
  | `src/lib/purchasing/loaders.js` | 468 |

- **The clock, read inside the engine (3 lines).** Train 2b.
  `src/lib/purchasing/loaders.js`: 235, 901, 1165.

- **Dates that are rules, and stay for good (2 lines).**
  `src/lib/kpi/overview/billback.js`: 49.
  `src/lib/purchasing/loaders.js`: 127.

- **Reads with no paging (24).** Train 2b. All measured against the
  live database on 2026-11-17; none returns more than 1,000 rows
  today.

  | v1 file | Line (what it reads) |
  |---|---|
  | `src/lib/kpi/overview/pnl-loader.js` | 59 (`kpi_period_status`), 97 and 101 (`kpi_account_flags`), 140 (`inventory_adjustments`), 394 (`sc_services`) |
  | `src/lib/kpi/overview/resolver.js` | 228 (`accounts`) |
  | `src/lib/labor/labor-week-basis.js` | 150 (`sc_qbo_service_map`) |
  | `src/lib/labor/loaders.js` | 123 and 210 (`kpi_budgets`), 130, 137, 217 and 224 (`sc_labor_budgets`), 343 (`labor_actuals_latest`) |
  | `src/lib/labor/salaryBoard.js` | 54 (`kpi_budgets`) |
  | `src/lib/purchasing/loaders.js` | 745, 750, 842 and 1571 (`accounts`), 808 (`purchasing_actuals`), 987 (`billcom_ref_vendors`), 1112 (`rippling_raw_spend_lines_latest`), 1123 (`spend_category_map`), 1413 (`spend_work_location_site_map`) |

- **Pagination on a non-unique key, in billback.**
  `src/lib/kpi/overview/billback.js` pages `sc_daily_revenue` with
  `.order("service_date")` and `.range(lo, hi)` by 1,000. The
  `service_date` column is not unique across rows (one day has
  many `service_id` values on multi-service sites), so at a page
  boundary Postgres is free to return a sibling-day row from
  either side of the cut. The same query at two moments can pick
  up a row twice or drop one, and the resulting
  `period_meals / sum_fy_meals` ratio shifts by one or two units.
  Observed as a flakiness on STL - FL's `billback_period.goal`
  during the same-answers proof - two cases failed in the main
  217 run, but the same inputs rerun ten times each immediately
  after both passed ten of ten (see
  `~/Downloads/KPI_V2_Handoff/proof_2a/stl_fl_10x.json`). Not
  fixed in this train; the same-code measure says billback.ts is
  byte-identical to v1.

## What V2 changed from v1

One change in the move itself:

1. **The two regional-director display names are inputs, not
   derived.** v1's `src/lib/kpi/overview/resolver.js` imported
   `REGIONAL_DIRECTORS` from `src/lib/incidentSchema.js` (addresses
   in code) and ran a local `ovRdoDisplayName` helper on them. V2
   drops that import and that helper; the two display names arrive
   as `regionalDirectorEastDisplay` and `regionalDirectorWestDisplay`
   on `resolveOverview`, both `null` by default. v1's own comment at
   the folio site says a null name is already handled.

Every other v1 line comes across unchanged; every v1 comment carries
with its code (modulo privacy redactions - see the report).

## Train 2b - the year, the clock and paging become inputs (2026-11-17)

Train 2a left three things typed in. Train 2b makes each a caller
input and makes every read complete and repeatable.

### The fiscal year is an input

`src/lib/kpi/shared/fiscalYear.ts` adds:

- `type FiscalYear` with `year`, `startISO`, `endISO`, and a
  13-period `periods` array (`period_no`, `startISO`, `endISO`).
- `buildFiscalYear(year, rows)` that validates: exactly 13 rows,
  each 28 days, back to back. Any violation throws from the loader.
- `loadFiscalYear(supa, year)` that reads `fiscal_periods` sorted by
  `period_no` and hands the result to `buildFiscalYear`.

Every function that previously typed in `"2025-12-29"`, `"2026-12-27"`
or `FISCAL_YEAR = 2026` now takes the year as an argument. Period
arithmetic reads `fy.periods[p-1]` rather than re-deriving a date by
adding 28 days to a typed-in start. The entry (`getOverview`) takes
`fiscalYear` as a required input and threads it to `resolveOverview`.
A search under `src/lib/kpi/**`, outside tests and `proof/`, finds
no fiscal year and no year-bound literal besides the two rule dates
noted above.

### The clock is an input

`getOverview` now takes `now: Date | string | number` in addition
to `today`. `resolveOverview` forwards `now` to `purchasing/loaders`
for the three sites that used to call the clock directly:

- `paginateInvoiceSubmissions`' `derivedAt` stamp on drill rows
  (`now.toISOString()`).
- `loadFreshness`' `report_age_hours` computation (`now.getTime()`).
- `loadCardCharges`' oldest-age clamp (`today` string input).

A search under `src/lib/kpi/**`, outside tests and `proof/`, for
`new Date()` with no argument and for `Date.now()` returns nothing.

### Every read goes through one paging helper

`src/lib/kpi/shared/pagedSelect.ts` adds `pagedSelect(build, opts)`.
The helper takes a `build(from, to)` that returns the completed
PostgREST builder (already chained with `.select` / `.in` / `.gte` /
`.lte` / `.order` / `.range`), walks pages of `pageSize` (default
1000), concatenates rows, and stops on a short page.

Every paged read under `src/lib/kpi/**` now sorts on a unique chain.
The reads table below names each caller, the table or view, the
sort chain, and why it is unique.

Exempt from the helper: `.single()` / `.maybeSingle()` (one row by
definition) and reads bounded by caller-chunked id lists where the
chunk size is 100 and the id is the table's primary key. Listed
below as `id-list`.

### Reads under src/lib/kpi/\*\*

| Caller (file:function) | Table / view | Sort chain | Why unique | Paging |
|---|---|---|---|---|
| `shared/fiscalYear.ts:loadFiscalYear` | `fiscal_periods` | `period_no` (inside `fiscal_year`) | `(fiscal_year, period_no)` PK | paged |
| `overview/pnl-loader.ts:loadPeriodStatus` | `kpi_period_status` | `period_no` (inside `fiscal_year`) | `(fiscal_year, period_no)` PK | paged |
| `overview/pnl-loader.ts:loadAccountFlags` | `kpi_account_flags` | `account_key` | PK | paged |
| `overview/pnl-loader.ts:loadInventoryAdjustments` | `inventory_adjustments` | `account_key, period_no, category, gl_line_code` | row grain is `(account_key, fiscal_year, period_no, category, gl_line_code)`; fiscal_year is fixed by the filter | paged |
| `overview/pnl-loader.ts:loadPnlActuals` | `pnl_actuals` | `account_key, period_no, line_code` | PK is `(account_key, fiscal_year, period_no, line_code)`; fiscal_year fixed | paged |
| `overview/pnl-loader.ts:loadOverviewBudgets` | `kpi_budgets` | `account_key, line_code, period_no` | PK is `(account_key, line_code, fiscal_year, period_no)`; fiscal_year fixed | paged |
| `overview/pnl-loader.ts:loadScDailyRevenue` | `sc_daily_revenue` | `account_key, service_date, service_id` | row grain is `(account_key, service_id, service_date)` | paged |
| `overview/pnl-loader.ts:loadScDailyRevenueCarveOut` sc_services step | `sc_services` | `id` | PK (uuid) | paged |
| `overview/pnl-loader.ts:loadScDailyRevenueCarveOut` daily read | `sc_daily_revenue` | `account_key, service_date, service_id` | same as above | paged |
| `overview/billback.ts:loadBillbackGoal` | `kpi_billback_goals` | n/a (`.maybeSingle()`) | single row | exempt |
| `overview/billback.ts:loadProjectedMealsByPeriod` | `sc_daily_revenue` | `service_date, service_id` | row grain `(account_key fixed, service_id, service_date)` | paged |
| `overview/billback.ts:loadReimbursableActualsByPeriod` pre lane | `purchasing_actuals` | `txn_date, id` | `id` (bigint) PK | paged |
| `overview/billback.ts:loadReimbursableActualsByPeriod` card lane | `purchasing_actuals` | `txn_date, id` | PK | paged |
| `overview/billback.ts:loadReimbursableActualsByPeriod` bill lane | `invoice_submissions` | `submitted_at, id` | `id` (uuid) PK | paged |
| `overview/billback.ts:loadReimbursableGlCodes` | `gl_codes` | `code` (inside `account_key`) | PK is `(account_key, code)`; account_key fixed | paged |
| `overview/resolver.ts:fetchAccountsDirectoryOv` | `accounts` | `team_key` | PK | paged |
| `labor/labor-week-basis.ts:loadWeeklyRevenueBasis` catering step | `sc_qbo_service_map` | `account_key, service_id` | row grain | paged |
| `labor/labor-week-basis.ts:loadWeeklyRevenueBasis` daily read | `sc_daily_revenue` | `account_key, service_date, service_id` | row grain | paged |
| `labor/loaders.ts:paginateActuals` | `labor_actuals_latest` | `week_start, account_key, worker_id` | row grain `(account_key, worker_id, week_start)` | paged |
| `labor/loaders.ts:resolveMemberBudget` kpi_budgets | `kpi_budgets` | `period_no` (inside fixed account_key + line_code + fiscal_year) | PK fixed | paged |
| `labor/loaders.ts:resolveMemberBudget` sc_labor_budgets | `sc_labor_budgets` | `period, effective_from, id` | `id` (uuid) PK | paged |
| `labor/loaders.ts:resolveMemberBudgets` kpi_budgets | `kpi_budgets` | `account_key, period_no` | PK fixed modulo in-filter | paged |
| `labor/loaders.ts:resolveMemberBudgets` sc_labor_budgets | `sc_labor_budgets` | `account_key, period, effective_from, id` | PK includes `id` | paged |
| `labor/loaders.ts:buildPriorPeriodComparison` single-account read | `labor_actuals_latest` | `week_start, worker_id` (inside fixed account_key) | row grain unique on `(worker_id, week_start)` after account fixed | paged |
| `labor/salaryBoard.ts:load3100_2Budgets` | `kpi_budgets` | `account_key, period_no` | PK fixed modulo in-filter | paged |
| `labor/salaryBoard.ts:loadSalaryActuals` | `labor_salary_actuals` | `account_key, week_start, worker_id` | row grain | paged |
| `purchasing/loaders.ts:readPurchasingActuals` | `purchasing_actuals` | `txn_date, account_key, id` | `id` PK | paged |
| `purchasing/loaders.ts:paginateInvoiceSubmissions` | `invoice_submissions` | `invoice_date, account_key, id` | PK | paged |
| `purchasing/loaders.ts:paginateWeekly` view slice | `v_purchasing_by_site_week` | `account_key, week_start, gl_line_code, gl_bucket` | view groups on all four | paged |
| `purchasing/loaders.ts:loadCogsLineCountForPeriod` | `v_purchasing_by_site_week` | `account_key, week_start, gl_line_code, gl_bucket` | same | paged |
| `purchasing/loaders.ts:loadPriorPeriodHistory` | `v_purchasing_by_site_week` | `account_key, week_start, gl_line_code, gl_bucket` | same | paged |
| `purchasing/loaders.ts:loadPending` | `purchasing_actuals` | `source_line_id` (inside filters) | unique per rippling_spend row | paged |
| `purchasing/loaders.ts:fetchMembers` ALL / EAST / WEST | `accounts` | `team_key` | PK | paged |
| `purchasing/loaders.ts:loadPurchasingBudgets` | `kpi_budgets` | `account_key, line_code, period_no` | PK fixed modulo in-filter | paged |
| `purchasing/loaders.ts:computeSentinel` | `purchasing_actuals` | `id` | PK | paged |
| `purchasing/loaders.ts:loadAccountsDirectory` | `accounts` | `team_key` | PK | paged |
| `purchasing/loaders.ts:loadFreshness` x4 | `purchasing_derive_runs`, `purchasing_actuals` | n/a (`.limit(1).maybeSingle()`) | single row | exempt |
| `purchasing/loaders.ts:loadLedgerRows` main | `purchasing_actuals` | `txn_date, id` | PK | paged |
| `purchasing/loaders.ts:loadLedgerRows` vendor names | `billcom_ref_vendors` | `.in("id", idChunk)` with id PK | ≤ 100 rows per chunk | id-list |
| `purchasing/loaders.ts:loadCardCharges` main | `purchasing_actuals` | `txn_date, id` | PK | paged |
| `purchasing/loaders.ts:loadCardCharges` raw-ids | `rippling_raw_spend_lines_latest` | `.in("rippling_id", idChunk)` | ≤ 100 rows per chunk | id-list |
| `purchasing/loaders.ts:loadCardCharges` cat labels | `spend_category_map` | `.in("category_id", idChunk)` | ≤ 100 rows per chunk | id-list |
| `purchasing/loaders.ts:loadVendorRollup` bill lane | `v_purchasing_actuals_billcom_named` | `id` | underlying PK | paged |
| `purchasing/loaders.ts:loadVendorRollup` card lane | `purchasing_actuals` | `id` | PK | paged |
| `purchasing/loaders.ts:loadCompliance` main | `rippling_report_txns_latest` | `purchased_at, id` | PK (bigint) | paged |
| `purchasing/loaders.ts:loadCompliance` label map | `spend_work_location_site_map` | `work_location_label, work_location_id` | row grain is `(work_location_id)` | paged |
| `purchasing/loaders.ts:loadCompliance` region read | `accounts` | `team_key` | PK | paged |
| `portfolioMembers.ts:resolvePortfolioMembers` | `accounts` | `team_key` | PK `(team_key)` verified in pg_constraint 2026-11-20 | paged |
| `labor/workerWeekRates.ts:loadWorkerWeekRates` presence read | `rippling_current_presence` | `rippling_id` (`kind` fixed by `.eq`) | PK `(kind, rippling_id)` verified in pg_constraint 2026-11-20 | paged |
| `labor/workerWeekRates.ts:loadWorkerWeekRates` pay-segments read | `rippling_raw_pay_segments` | `rippling_id, id` | PK is `(id)` not `rippling_id` (rippling_id has 4,428 repeats in 26,527 rows verified 2026-11-20); `(rippling_id, id)` unique by schema | paged |
| `labor/preFloorEstimator.ts:deriveAccountBaseRates` daily read | `labor_actuals_daily` | `work_date, worker_id, line_code` (`account_key` fixed by `.eq`) | PK `(account_key, worker_id, work_date, line_code)` verified in pg_constraint 2026-11-20 | paged |
| `labor/preFloorEstimator.ts:deriveAccountBaseRates` schedule read | `sc_homestand_schedule` | `service_date` (`account_key` fixed by `.eq`) | UNIQUE `(account_key, service_date)` verified in pg_constraint 2026-11-20 | paged |
| `labor/preFloorEstimator.ts:foldPreFloorEstimates` weekly read | `labor_actuals_latest` | `week_start, worker_id, line_code` (`account_key` fixed by `.eq`) | PK of underlying `labor_actuals` is `(account_key, worker_id, week_start, line_code)` verified in pg_constraint 2026-11-20 | paged |
| `labor/preFloorEstimator.ts:foldPreFloorEstimates` schedule read | `sc_homestand_schedule` | `service_date` (`account_key` fixed by `.eq`) | UNIQUE `(account_key, service_date)` verified 2026-11-20 | paged |
| `labor/homestandResolver.ts:listHomestands` schedule read | `sc_homestand_schedule` | `service_date` (`account_key` fixed by `.eq`) | UNIQUE `(account_key, service_date)` verified 2026-11-20 | paged |
| `labor/homestandResolver.ts:listHomestands` hourly budget | `kpi_budgets` | `period_no` (`account_key`, `line_code`, `fiscal_year` fixed by `.eq`) | PK `(account_key, line_code, fiscal_year, period_no)` verified in pg_constraint 2026-11-20 | paged |
| `labor/homestandResolver.ts:listHomestands` salary budget | `kpi_budgets` | `period_no` (`account_key`, `line_code`, `fiscal_year` fixed by `.eq`) | PK `(account_key, line_code, fiscal_year, period_no)` | paged |
| `labor/homestandResolver.ts:resolveDailyFloor` | `labor_actuals_latest` | n/a (`.limit(1).maybeSingle()`) | single row by definition | exempt |
| `labor/homestandResolver.ts:foldPerStandSplits` daily read | `labor_actuals_daily` | `work_date, worker_id, line_code` (`account_key` fixed by `.eq`) | PK `(account_key, worker_id, work_date, line_code)` | paged |
| `labor/dailyRangeBody.ts:buildDailyRangeBody` members read | `accounts` | `team_key` | PK `(team_key)` | paged |
| `labor/dailyRangeBody.ts:buildDailyRangeBody` daily read | `labor_actuals_daily` | `account_key, worker_id, work_date, line_code` | PK `(account_key, worker_id, work_date, line_code)` | paged |
| `labor/dailyRangeBody.ts:buildDailyRangeBody` budget read | `kpi_budgets` | `account_key, period_no` (`line_code`, `fiscal_year` fixed by `.eq`) | PK `(account_key, line_code, fiscal_year, period_no)` | paged |
| `labor/salaryBoard.ts:loadSalaryActuals` | `labor_salary_actuals` | `account_key, week_start, worker_id` (`.in("account_key", members)`) | UNIQUE `(worker_id, week_start)` verified in pg_constraint 2026-11-20; account_key prefix does not break uniqueness | paged |
| `entry.ts:fetchAccountsDirectoryLabor` | `accounts` | `team_key` | PK | paged |
| `entry.ts:getLabor` walk freshness | `rippling_walks` | n/a (`.limit(1).maybeSingle()`) | single row | exempt |
| `entry.ts:getLabor` weekly derive freshness | `labor_actuals` | n/a (`.limit(1).maybeSingle()`) | single row | exempt |
| `entry.ts:getLabor` daily derive freshness | `labor_actuals_daily` | n/a (`.limit(1).maybeSingle()`) | single row | exempt |
| `entry.ts:getLabor` daily floor | `labor_actuals` | n/a (`.limit(1).maybeSingle()`) | single row | exempt |
| `entry.ts:getLabor` homestand daily | `labor_actuals_daily` | `work_date, worker_id, line_code` (inside fixed account_key) | row grain | paged |
| `entry.ts:getLabor` homestand schedule | `sc_homestand_schedule` | `service_date` (inside fixed account_key) | row grain | paged |
| `entry.ts:getLabor` aggregate day metadata | `sc_day_metadata` | `service_date` (inside fixed account_key) | row grain `(account_key, service_date)` | paged |
| `entry.ts:getLabor` aggregate unattributed | `labor_unattributed` | `amount desc, worker_id, first_seen_date, reason_code, department_id` | unique per row | paged |
| `entry.ts:getLabor` aggregate unmapped names | `earning_type_unmapped` | `total_amount desc, merged_earning_type_name` | merged_earning_type_name is unique | paged |
| `entry.ts:getLabor` single actuals | `labor_actuals_latest` | `week_start, worker_id` (inside fixed account_key) | row grain `(account_key, worker_id, week_start)` | paged |
| `entry.ts:getLabor` single unattributed | `labor_unattributed` | `amount desc, worker_id, first_seen_date, reason_code, department_id` | unique per row | paged |
| `entry.ts:getLabor` single day metadata | `sc_day_metadata` | `service_date` (inside fixed account_key) | row grain | paged |
| `entry.ts:getLabor` single unmapped names | `earning_type_unmapped` | `total_amount desc, merged_earning_type_name` | merged_earning_type_name is unique | paged |
| `entry.ts:getLabor` single pnl budgets | `kpi_budgets` | `period_no` (inside fixed account_key + line_code + fiscal_year) | PK fixed | paged |
| `entry.ts:getLabor` single sc_labor_budgets | `sc_labor_budgets` | `period, effective_from, id` (inside fixed account_key) | `id` (uuid) PK tie-breaker | paged |
| `entry.ts:getPurchasing` reimb names | `billcom_ref_accounts` | `account_number, id` | PK is `(id)` not `account_number` (account_number has 150 repeats in 1,072 rows verified 2026-11-20); `(account_number, id)` unique by schema | paged |
| `entry.ts:getPurchasing` billcom vendor names | `billcom_ref_vendors` | `.in("id", idChunk)` with id PK `(id)` verified 2026-11-20 | ≤ 100 rows per chunk | id-list |

### Train 2c - labor + purchasing take the inputs (2026-11-20)

Labor and purchasing move from `src/app/api/kpi/{labor,purchasing}/route.js`
in v1 into `src/lib/kpi/**` entry functions (`getLabor`, `getPurchasing`).
The three inputs trained-in on 2b (fiscal year, clock, paging) are
now the caller's responsibility across the labor and purchasing
code-paths too. No file under `src/lib/kpi/**` reads the clock to
make a decision, types a year in, or reads a Supabase table without
`pagedSelect` or an equivalent exemption. `homestandResolver.ts`
retains the `FY_BOUNDARIES` table as a reference for cross-season
historical lookups; the engine itself consumes `fy: FiscalYear`
threaded from the entry.

### Train 2b expectation changes

One class of behaviour changes by design: a period function's
answer for an input outside the fiscal year it was given. The
table-driven engine returns `null`; v1's typed-in arithmetic
extrapolated. Every twin-test expectation that moved is listed
here with its input - each input is verified to be outside the
year.

| Function | Input | v1 return | v2 (train 2b) |
|---|---|---|---|
| `rangeForPeriod` | `14` (period_no outside [1, 13]) | `{ startISO: "2026-12-28", endISO: "2027-01-24" }` | `null` |

No other twin test moved.

### Entry log line

v1's `GET` handler in `src/app/api/kpi/overview/route.js` logged the
scope and the error message on a 5xx; train 2a dropped the log. The
entry now restores it: `console.error` with `scope: message` plus
`stack`. Never a payload, figure, name or address. The only reader
of the log is the server operator; the body returned to the HTTP
caller is still `{ error: "server_error", scope }` as before.

### IEEE 754 float noise from the unique-sort tie-breakers

Adding a tie-breaker to a paged `.order(...)` chain makes the sort
unique at page boundaries. Several accounts have `purchasing_actuals`
pre-cutover reads that cross the 1,000-row cap in fiscal 2026
(CIN - AZ 1,116; STL - FL 1,783; TBJ - FL 1,874; TBR - FL 1,777;
TXR - AZ 1,319), so the tie-breaker is required for correctness on
those reads. Within any one page the tie-breaker also reorders rows
that share a date; IEEE 754 float addition is not associative, so
the sum of `purchasing_actuals.amount` per period differs from v1's
natural (DB-default-on-ties) order by exactly 1 ULP. The resulting
payload numbers are byte-for-byte correct to cent precision; both
v1 and the entry equal the direct DB sum to within 1e-6.

The paging rule applies uniformly. The tie-breakers stay. The ULP
noise is a benign consequence; `~/Downloads/KPI_V2_Handoff/proof_2b/
direct_sums_all.json` is the receipt for every case flagged by the
217-case proof: both v1 and the entry match the direct sum on every
CIN - OH and STL - MO billback figure; the entry alone matches on
every STL - FL figure (there v1's non-unique sort drops rows at the
page boundary).

### The paging rule (no small-read exception)

Every paged read under `src/lib/kpi/**` sorts on a unique key.
This rule has no exception for a read that is small today - row
counts grow. A read that fits in one page in fiscal 2026 can
page in fiscal 2027; a sort that is unique within the current
filter can become non-unique after a schema change. The rule is
maintained by `pagedSelect` and audited by the reads table above.

### 217-case same-answers result (rerun 2026-11-20)

```
pass:     194
fail:      23
unstable:   0
total:    217
```

Classified by root cause:

- **13 STL - FL** - v1 is off, the entry equals the direct DB
  sum on every per-period meal goal. v1's
  `loadProjectedMealsByPeriod` paged its `sc_daily_revenue` read
  with `.order("service_date")` only. STL - FL has 2,827 meal
  rows for fiscal 2026 and `service_date` is not unique within an
  account's rows, so same-date rows straddling the 1,000-row page
  boundary drop or duplicate. The entry tie-breaks with
  `.order("service_id")` and matches direct byte-for-byte on
  every goaled period.

- **10 CIN - OH / STL - MO** - both v1 and the entry equal the
  direct DB sum to the cent. The payload numbers differ only in
  float representation (IEEE 754 ULP) from the row-order change
  introduced by the unique-sort tie-breaker on
  `purchasing_actuals`. No defect; no fix; both answers are
  correct.

Per-case verdicts and per-field classifications live in
`~/Downloads/KPI_V2_Handoff/proof_2b/direct_sums_all.json`.

## Train 2d-1 - closed-range screen rules (2026-11-20)

v1's closed-range KPI Overview page draws eleven blocks above the
fold. Train 2d-1 moves the logic behind each block out of v1's
React components into `src/lib/kpi/screen/**` as plain data-in /
data-out TypeScript functions. No JSX, no hooks, no CSS, no clock
read, no DB read. Nothing calls the new surface - this train only
builds the measurements.

Running / planned ranges are train 2d-2. Only closed single-period
and the year are modelled here.

### Function list

| V2 path | Public functions | Shape returned |
|---|---|---|
| `src/lib/kpi/screen/formatting.ts` | re-exports `formatMoneyWhole` / `formatPct` / `fmtWeekRange` / `formatDayLabel` / `pctOf` / `gapDollarsCost` / `gapDollarsRevenue` / `gapDollarsMargin` / `gapPointsCost` / `gapPointsRevenue` / `gapPointsMargin` / `directionOfDelta`; adds `formatMMDD` / `formatHoursTwoDecimals` / `formatPersonCount` / `formatDaysCount` / `pluralWeeks` / `signedMagnitudeMoney` / `fmtHrs` / `fmtHrsRounded` | strings or `{ magnitude, direction }` |
| `src/lib/kpi/screen/dashOrValue.ts` | `resolveDashState` / `dashOrValue` / `formatDashOrValue` | dash state word + display string |
| `src/lib/kpi/screen/statusLine.ts` | `buildStatusLine` / `buildAwaiting` / `formatStatusLine` | `{ state, tone, state_copy, leading_dot, awaiting, horizon }` |
| `src/lib/kpi/screen/settlingStrip.ts` | `buildSettlingStrip` / `formatSettlingStrip` | `{ render, period_no, purchases, labour }` |
| `src/lib/kpi/screen/overdueNudge.ts` | `buildOverdueNudge` / `formatOverdueNudge` | `{ render, entries[] }` |
| `src/lib/kpi/screen/cardsRow.ts` | `buildCardsRow` / `formatCardsRow` | three cards: `{ budget, adjusted, actual, pct_actual, pct_adjusted, pct_target, gap_dollars, gap_points, verdict, provisional }` |
| `src/lib/kpi/screen/revenueLines.ts` | `buildRevenueLines` / `formatRevenueLines` | rows + total + pill |
| `src/lib/kpi/screen/costLines.ts` | `buildCostLines` / `formatCostLines` | rows + total + pill (closed-range shape only) |
| `src/lib/kpi/screen/alsoTracked.ts` | `buildAlsoTracked` / `formatAlsoTracked` | per-line { state, budget, actual, variance, tone } |
| `src/lib/kpi/screen/pnlStatement.ts` | `buildPnlStatement` / `formatPnlStatement` | `{ summary_rows[], full_rows[] }`, each row with hatch flags + verdict |
| `src/lib/kpi/screen/weekRail.ts` | `buildWeekRail` / `formatWeekRail` | `{ render, period_no, running_week_no, confirmed_count, total_count, tiles[] }` |
| `src/lib/kpi/screen/weekFlag.ts` | `flagForV42State` | `{ state, label, cls, tooltip, glyph }` or null |
| `src/lib/kpi/screen/weekTableModels.ts` | `buildMemberByWeekAndAcct` | `Map<week, Map<account, accumulator>>` |
| `src/lib/kpi/screen/laborAggregate.ts` | `workerLabel` / `buildFilteredActuals` / `buildWeekAggregates` / `buildGrouped` / `buildWorkerRoster` / `buildGrand` / `buildWorkerRangeTotals` / `computeResolvedPreset` / `periodsInBoardWeeks` | plain JS objects (verbatim v1 shapes) |
| `src/lib/kpi/screen/laborLedger.ts` | `buildLaborLedger` / `formatLaborLedger` | `{ render, header_summary, weeks[], grand }` |
| `src/lib/kpi/screen/purchasingFold.ts` | `buildPurchasingFold` / `formatPurchasingFold` | `{ render, variant, transactions[], foot, week_bands[], show_vehicle }` |
| `src/lib/kpi/screen/index.ts` | re-exports every builder + formatter | - |

### Screen-time logic moved

Every piece of per-component arithmetic that v1 did inside a
`"use client"` React component and needs a value out of it. v1
file + line range -> V2 function:

| v1 file (closed branch) | v1 lines | What it works out | V2 function |
|---|---|---|---|
| `components/StatusLine.js` | 37-50 | awaiting-pill sentence from settle_iso | `buildStatusLine` + `formatStatusLine` |
| `page.js` (closed branch) | 787-814 | `awaiting` object (fytd + r93 + settle+8) | `buildAwaiting` |
| `components/SettlingStrip.js` | 32-42 | labour threshold (0.04 hrs, 1 person) + sentences | `buildSettlingStrip` + `formatSettlingStrip` |
| `components/OverdueNudge.js` | 14-28 | per-period "N days ago" sentence | `buildOverdueNudge` + `formatOverdueNudge` |
| `components/CardsRow.js` | 265-350 (CogsTooltip envelope) | plan + adjusted percent routing | `buildCardsRow` (adjusted_pct fallback to target_pct) |
| `components/CardsRow.js` | 132-182 (VarianceFoot) | over/under + ahead/behind + above/below labels | `formatCardsRow.varianceInfo` |
| `components/CardsRow.js` | 400-500 (RevenueCard reference) | fytd vs single-closed branch for revenue reference | `buildCardsRow` (range.kind gate) |
| `components/CardsRow.js` | 546-620 (PercentLeadCard) | adjusted figure + percent + target percent beside | `buildCardsRow.cogs/gross_margin` |
| `components/RevenueLines.js` | 46-85 (Row) | per-row budget/actual/pct, inactive filter | `buildRevenueLines` |
| `components/RevenueLines.js` | 110-160 (RevenueLines) | revenue-line pill (Verified/Live/Planned OR composition) | `buildRevenueLines.pill` |
| `components/CostLines.js` | 68-245 (CostRow) | adjusted, variance vs batr, credit rendering | `buildCostLines` |
| `components/CostLines.js` | 258-337 (TotalRow) | sum scored rows; total variance = sum(actual_scored) - sum(adjusted) | `buildCostLines.total` |
| `components/CostLines.js` | 631-680 (overCount, rowsWithSpend pill) | pill state picker | `buildCostLines.pill` |
| `components/AlsoTracked.js` | 29-85 (Row) | bothNullish / noBudget state picker + variance tone | `buildAlsoTracked` |
| `components/AlsoTracked.js` | 51-54 | closed-range empty phrase = "no spend" | `formatAlsoTracked` |
| `components/PnlStatement.js` | 71-93 (VarCell) | signed-arrow variance + "on budget" at < $1 | `formatPnlStatement` + `signedMagnitudeMoney` |
| `components/PnlStatement.js` | 112-217 (LineRow) | inactive row, credit row, hatch_target_pct / hatch_adjusted | `buildPnlStatement.buildLineRow` |
| `components/PnlStatement.js` | 244-300 (default export) | summary/full split + totals | `buildPnlStatement` |
| `components/WeekRail.js` | 51-75 (tileVariant, tileStateLabel) | in_progress/confirmed/forecast variant picker | `buildWeekRail.tileVariant` |
| `components/WeekRail.js` | 94-135 (tile body) | invoice_landed rule + labor caveats + fmt | `buildWeekRail` tiles |
| `components/LaborLedger.js` | 117-141 (headerSummary) | settled hours + dollars for the fold trigger | `buildLaborLedger.header_summary` |
| `components/LaborLedger.js` | whole | per-week row with batr + unapproved + verdict | `buildLaborLedger.weeks` |
| `components/PurchasingFold.js` | 119-172 (bucketOf, buildTransactions) | GL-code bucket + per-bill grouping (both variants) | `buildPurchasingFold.buildTransactions` |
| `components/PurchasingFold.js` | 175-210 (weekStartOf / weekEndOf / weekState) | FY-anchored week assignment + settled/in-progress/ahead | `buildPurchasingFold` |
| `components/PurchasingFold.js` | 213-260 (derived weekBands) | in-progress first, settled desc, ahead last | `buildPurchasingFold.week_bands` |
| `components/DashOrValue.js` | 24-33 | dash-state picker | `resolveDashState` (MOVED whole) |

### Moved whole (same-code) vs rewritten (data-only)

- **Move whole (3 files, 619 lines of v1 source)** - every byte-for-
  byte same. v2 adds `fy: FiscalYear` where v1 reads from its own
  periods module. Twin tests exercise identical input -> identical
  output.
  - `weekTableModels.js` (106 lines) -> `screen/weekTableModels.ts`
  - `weekFlag.js` (91 lines) -> `screen/weekFlag.ts`
  - `aggregate.js` (422 lines) -> `screen/laborAggregate.ts`
    (v2 passes `fy` into `periodOf`, `fiscalYearOf`, `currentPeriodNo`;
    body unchanged)
  - `DashOrValue.js` picker only (10 lines of logic) -> `resolveDashState`
    in `screen/dashOrValue.ts`

- **Rewrite (every other component)** - shape-matched models +
  formatters:
  - `StatusLine.js`, `SettlingStrip.js`, `OverdueNudge.js`,
    `CardsRow.js`, `RevenueLines.js`, `CostLines.js` (closed branch
    only), `AlsoTracked.js`, `PnlStatement.js`, `WeekRail.js`,
    `LaborLedger.js`, `PurchasingFold.js`.

### Labor_landed / purchasing_landed / unapproved_hours cross-site check

v1 writes these fields in exactly one place on the server:
`src/lib/kpi/overview/resolver.js:2400-2410` (grep-verified at the
pin). Each field on `week_rail.weeks[]` reads:

```js
labor_landed: r2(Number(w.spent || 0))
purchasing_landed: r2(Number(railPurchByWeek.get(w.week_start) || 0))
unapproved_hours: Number(w.unapproved_hours || 0)
```

`w.spent` comes from `labor.board.weeks[*]` (labor-engine board);
`railPurchByWeek` is a Map pre-built from `pnl-loader`'s per-week
purchasing split. The LaborLedger inside the fold reads
`labor.actuals[*].amount` and sums per week via
`buildWeekAggregates`.

**Same arithmetic? No, it is NOT the same expression.** The week-
rail labor_landed reads the board's `spent` field; the fold's per-
week dollars sum `actuals[*].amount`. Both feed off the same labor
derive pipeline and on a fully-settled closed period they match
within rounding; on in-progress weeks they can diverge (the board's
spent may add hatched dollars for unpriced hours, and the Rippling
labor table reads amount only).

This PR holds each value ONCE in the week_rail model
(`WeekRailTile.labor_landed`, `purchasing_landed`,
`unapproved_hours`) and ONCE in the labor-ledger model
(`LaborWeekRow.dollars`, `unapproved_hours`). Consumers wanting the
rail value read the rail tile; consumers wanting the fold value
read the week row. Two readers, two unambiguous sources - no third
"derived display" field at the model layer.

### Model contract (per function)

Kevin ruling 2026-11-20 (train 2d-1 PR #94 bounce, item 4).  Each
screen model exposes two layers: a **contract** (numbers + state
words that V2 screens read) and **proof-only passthroughs** (v1
display strings carried for the DOM-vs-model compare and nothing
else).  V2 screens format their own strings from the contract
numbers; the proof-only fields let the 92-case strict compare run
without re-capturing.

The convention: any field whose name ends in `_display` is proof-
only; any `*_label` / `*_arrow` field inherited from v1 wording is
proof-only; everything else is contract.

**cardsRow (`buildCardsRow` / `formatCardsRow`)**
- Contract: per-card `budget`, `adjusted`, `actual`, `pct_actual`,
  `pct_adjusted`, `pct_target`, `gap_dollars`, `gap_points`,
  `verdict`, `provisional`, `pill_side`, `hero_side`,
  `footer_suppressed`, `revenue_absent`.
- Proof-only: every `*_display`, `pill_label`, `variance_label`,
  `variance_arrow`, `variance_direction` - v1 text carried for the
  proof only; V2 screens format their own.

**revenueLines (`buildRevenueLines` / `formatRevenueLines`)**
- Contract: per-row `line_code`, `label`, `budget`, `actual`,
  `pct_of_revenue`, `tone`, plus the total shape and `pill.state`.
- Proof-only: every `*_display`, `pill_text` - v1 text for the
  proof only.

**costLines (`buildCostLines` / `formatCostLines`)**
- Contract: per-row `line_code`, `label`, `adjusted`, `target_pct`,
  `actual`, `actual_pct`, `variance_dollars`, `variance_pct`,
  `credit`, `flags`, `verdict`; total shape mirrors per-row
  including `verdict`; `pill.state`, `pill.over_count`,
  `pill.row_count`, `has_target`.
- Proof-only: every `*_display`, `pill_text`, `pill_tone` - v1
  text / class name for the proof only.

**alsoTracked (`buildAlsoTracked` / `formatAlsoTracked`)**
- Contract: per-row `line_code`, `label`, `budget`, `actual`,
  `variance`, `state`, `tone`.
- Proof-only: every `*_display`, `empty_phrase` - v1 text.

**pnlStatement (`buildPnlStatement` / `formatPnlStatement`)**
- Contract: `render`, `include_salary`, per-row `variant`,
  `line_code`, `label`, `section`, `axis`, `budget`, `target_pct`,
  `adjusted`, `actual`, `actual_pct`, `variance_dollars`,
  `ref_field`, every `hatch_*`, `indent`, `inactive`, `reported`,
  `credit`, `verdict` (both `summary_rows` and `full_rows`).
- Proof-only: every `*_display`, `variance_arrow`,
  `not_reported` - v1 text / row-caption carried for the proof.

**statusLine (`buildStatusLine` / `formatStatusLine`)**
- Contract: `state`, `tone`, `leading_dot`, `awaiting` (object
  shape), `horizon`.
- Proof-only: `state_copy`, `awaiting_copy` - v1 sentence text.

**settlingStrip, overdueNudge, weekRail, laborLedger, purchasingFold**
- Same convention: numeric aggregates + state enums are contract;
  every formatted sentence / `*_display` is proof-only.

**weekFlag (`flagForV42State`)**
- Contract: `state`, `cls`.
- Proof-only: `label`, `tooltip`, `glyph` - v1 copy / CSS classes.

**dashOrValue (`resolveDashState` / `dashOrValue`)**
- Contract: dash-state word.
- Proof-only: `formatDashOrValue` output string.

### Defects found but not fixed

None at the engine-arithmetic layer.  The labor ledger's week-row
dollars can differ from the week_rail's labor_landed on in-progress
weeks by hatched unpriced hours - that is a known-and-intentional
v1 behaviour (see v1 LaborLedger.js:117-141 comment "settled
dollars only") rather than a defect, and both figures are exposed
in the model so the consumer picks the one the render wants.

**Defects believed, not fixed (reproduce v1 exactly).**  Kevin
ruling 2026-11-20 (train 2d-1 PR #94 bounce, item 1): the model
must carry v1's side on the two patterns below.  Do not decide
whether v1 is right; reproduce it and list both here.

1. **PnL VarCell colours credit rows (PnlStatement.js:77-93 at pin
   c3c1b902).**  v1 renders the P&L variance cell for every row
   whose (actual, ref) are both non-null, including net-credit cost
   rows (e.g. a 3100.2 salary sub-row that lands as a credit, a
   tracked line 5002.5 Equipment with actual less than budget).
   Tone is driven purely by `actual - ref` + axis
   (`good = axis === "rev" ? up : !up`), without excluding credits.
   A credit row on a cost axis with `actual < ref` reads green
   (good) even though "green" more conventionally means "under
   spend" rather than "credit landed."  Model reproduces exactly;
   see `pnlStatement.ts` `rowVerdict()` and the inline comment
   above the `verdict:` field in `buildLineRow`.  Captured by the
   screen-models test "credit row (actual < 0, cost axis) ->
   verdict matches v1 VarCell."

2. **CostLines %rev greens the cell on null adjusted (CostLines.js
   line 212 at pin c3c1b902).**  v1 renders `kpi-ov-good` when
   `over` is false and the row is not suppressed.  `over` is
   `varianceVsBatr > 0`; when adjusted (batr) is null (e.g. a line
   with a target percent but no dollar reference), `varianceVsBatr`
   is null and `over` evaluates false - so v1 still paints the
   cell green regardless of what the actual value is.  Model
   reproduces exactly; see `costLines.ts` `buildCostLines` row loop
   and the inline comment above the row's `verdict` block.  Captured
   by the screen-models test "row with target_pct but null adjusted
   -> verdict 'good' (v1 CostRow:212)."

### Historical defects note

Every arithmetic shape observed in v1 reproduces in the model; one
notable artefact (the labor ledger's week-row dollars can differ
from the week_rail's labor_landed on in-progress weeks, by hatched
unpriced hours) is a known-and-intentional v1 behaviour (see v1
LaborLedger.js:117-141 comment "settled dollars only") rather than
a defect, and both figures are exposed in the model so
the consumer picks the one the render wants.
