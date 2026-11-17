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
