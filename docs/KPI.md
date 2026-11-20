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
