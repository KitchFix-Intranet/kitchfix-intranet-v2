// src/lib/kpi/entry.ts
//
// The engine's one public door.
//
// Train 2b inputs (beyond train 2a):
//   fiscalYear  a loaded FiscalYear object. The entry does not guess
//               a year from today's date; the caller passes the one
//               the request is for. Two different years can be served
//               by the same running process at the same moment.
//   now         a full timestamp from the caller. The engine never
//               reads the clock; every leaf that needs "the current
//               moment" reads from this field. Same shape as `today`:
//               an input, never derived.
//
// The entry does what v1's GET handler does from line 111 to line
// 298 of route.js, in the same order, with the same outcomes
// (preview narrowing, no-account landing, CORP refusal, not-authorised,
// salary gate, parseRange, resolveOverview, preview_account /
// landing_account / export / range_snap / todayISO).

import { resolvePreviewAccess } from "./previewAccess";
import { canViewAccount, canSeeSalary, landingAccount } from "./roleGate";
import { isKnownAccount, PASS_THROUGH_ACCOUNTS, PURCHASING_ENVELOPE_EXCLUSIONS } from "./accountModels";
import { resolveOverview } from "./overview/resolver";
import { snapRange } from "./rangeSnap";
import {
  periodStartISO, periodEndISO, periodOf as periodOfLabor,
  weekStartsInRange, inferRangeSelection, currentPeriodNo,
} from "./labor/periods";
import type { FiscalYear } from "./shared/fiscalYear";
// Labor imports.
import { resolveWorkerMeta } from "./resolveWorkerMeta";
import { resolvePortfolioMembers } from "./portfolioMembers";
import { pagedSelect } from "./shared/pagedSelect";
import { DOLLAR_COVERAGE_FLOOR } from "./floors";
import { buildWorkerToEmail } from "./labor/personCount";
import { buildBoard, buildWeekBudgets, buildAggregateWeekBudgets } from "./labor/board";
import {
  loadOverviewBudgets, computeContractualAccrualByPeriod, sumPeriodRevenue,
  loadPnlActuals, loadPeriodStatus, budgetAtThisRevenue,
} from "./shared/periodBasis";
import {
  resolveFinanceCloseAdjustment, applyFinanceCloseToLaborBoard,
} from "./shared/financeCloseAdjustment";
import {
  loadRangeRevenueBasis, attachBatrToBoard, periodsClosedBefore,
  recomputeVerdictFromPanel, recomputePanelBatrFromPerWeek,
} from "./labor/labor-batr";
import {
  loadWeeklyRevenueBasis, computeLineTargetPctByPeriod,
  computeMergedLineTargetPctByPeriod, attachWeeklyBasisToBoard,
} from "./labor/labor-week-basis";
import {
  load3100_2Budgets, loadSalaryActuals, withSalary as withSalaryMerge, pinHourlyOnly,
} from "./labor/salaryBoard";
import { salaryProRate } from "./labor/salaryProRate";
import { resolveRangeSource } from "./labor/rangeResolver";
import { buildDailyRangeBody } from "./labor/dailyRangeBody";
import {
  listHomestands, computeHomestandBank, actualsByStand, foldPerStandSplits,
} from "./labor/homestandResolver";
import { foldPreFloorEstimates } from "./labor/preFloorEstimator";
import { loadWorkerWeekRates } from "./labor/workerWeekRates";
import {
  V37_REVENUE_FLEX_ACCOUNTS,
  paginateActuals as paginateLaborActuals,
  resolveMemberBudgets,
  buildPriorPeriodComparison,
} from "./labor/loaders";
// Purchasing imports.
import { loadReportOnlyPending, mergePending } from "./purchasing/precedence";
import {
  IN_CHUNK, chunk,
  paginateActuals as paginatePurchasingActuals,
  paginateWeekly,
  loadPriorPeriodHistory, loadPending, fetchMembers,
  loadPurchasingBudgets, computeSentinel, loadAccountsDirectory, loadFreshness,
  loadLedgerRows, loadCardCharges, loadVendorRollup, loadCompliance,
} from "./purchasing/loaders";
import { canonicalSubLine, isDescendantOfLine } from "./purchasing/glRollup";

const V6_PSEUDO_KEYS = new Set(["ALL", "EAST", "WEST"]);

// v1 route.js `safeError` + its log line. Train 2b restores the log
// so a 5xx is never silent. Scope + error.message only; a payload,
// figure, name or address never appears here.
function safeError(scope: string, err: any) {
  try {
    const message = err?.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error(`[kpi/overview] ${scope}: ${message}`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[kpi/overview] ${scope}: (unprintable error)`);
  }
  return { error: "server_error", scope };
}

function safeErrorLabor(scope: string, err: any) {
  try {
    const message = err?.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error(`[kpi/labor] ${scope}: ${message}`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[kpi/labor] ${scope}: (unprintable error)`);
  }
  return { error: "server_error", scope };
}

function safeErrorPurchasing(scope: string, err: any) {
  try {
    const message = err?.message ?? String(err);
    // eslint-disable-next-line no-console
    console.error(`[kpi/purchasing] ${scope}: ${message}`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[kpi/purchasing] ${scope}: (unprintable error)`);
  }
  return { error: "server_error", scope };
}

// parseRange mirrors v1 route.js:58-84. The caller supplies the four
// query-string pieces as plain strings; the entry does not read the
// URL itself.
function parseRange({ range = "", start = "", end = "" }: { range?: string; start?: string; end?: string }, today: string, fy: FiscalYear) {
  const rangeParam = range.trim();
  const startParam = start.trim();
  const endParam = end.trim();
  if (rangeParam === "fytd") return { snap: snapRange("", "", today, fy), rangeParamSeen: "fytd" };
  if (rangeParam.startsWith("period:")) {
    const n = Number(rangeParam.slice("period:".length));
    if (Number.isInteger(n) && n >= 1 && n <= 13) {
      return {
        snap: {
          start: periodStartISO(n, fy), end: periodEndISO(n, fy),
          kind: "period", period_no: n,
          start_period_no: n, end_period_no: n,
          snapped: false, snapped_from: null,
        },
      };
    }
  }
  return { snap: snapRange(startParam, endParam, today, fy) };
}

type EntryQuery = {
  account?: string;
  preview?: string;
  include_salary?: boolean | string;
  debug?: string;
  range?: string;
  start?: string;
  end?: string;
};

type EntryCaller = {
  role: string;
  scope: string | null;
  can_see_salary?: boolean;
} | null;

type EntryArgs = {
  supa: any;
  today: string;
  now: Date | string | number;
  fiscalYear: FiscalYear;
  caller: EntryCaller;
  query?: EntryQuery;
  regionalDirectorEastDisplay?: string | null;
  regionalDirectorWestDisplay?: string | null;
};

type EntryResponse = {
  status: number;
  body: any;
};

export async function getOverview({
  supa,
  today,
  now,
  fiscalYear,
  caller,
  query = {},
  regionalDirectorEastDisplay = null,
  regionalDirectorWestDisplay = null,
}: EntryArgs): Promise<EntryResponse> {
  let account = (query.account || "").trim();
  const previewParam = (query.preview || "").trim();
  const includeSalaryReq = query.include_salary === "1" || query.include_salary === true;
  const debug = (query.debug || "").trim().toLowerCase();
  const debugTiming = debug === "timing";

  // Preview target validation (mirrors purchasing route). Silent-ignore
  // an unknown preview matches resolvePreviewAccess's safety spirit.
  const previewIsValidTarget = previewParam && (
    isKnownAccount(previewParam) || V6_PSEUDO_KEYS.has(previewParam)
  );
  const preview = resolvePreviewAccess({
    caller,
    canViewAccount,
    urlAccount: account,
    previewParam: previewIsValidTarget ? previewParam : "",
  });
  account = preview.account;
  const preview_account = preview.preview_account;

  const landing_account = landingAccount(caller);

  // No account -> landing response (matches labor's shape).
  if (!account) {
    return {
      status: 200,
      body: { landing_account, preview_account, todayISO: today },
    };
  }
  if (account === "CORP") {
    return { status: 400, body: { error: "account_out_of_scope", account } };
  }

  // Locked-state response for accounts the caller cannot view.
  if (!canViewAccount(caller, account)) {
    return {
      status: 200,
      body: {
        locked: true,
        account,
        reason: "not_authorised",
        landing_account,
        preview_account,
        todayISO: today,
      },
    };
  }

  // Role gate for salary. The resolver receives the account-aware
  // value (not the raw caller.can_see_salary) so its internal check at
  // src/lib/kpi/overview/resolver.ts (`salaryAvailable: caller?.can_see_salary === true`)
  // matches the fetch.
  const salaryAvailable = canSeeSalary(caller, account);
  const includeSalary = includeSalaryReq && salaryAvailable;

  // Range resolution.
  let parsed;
  try { parsed = parseRange(query, today, fiscalYear); }
  catch (e) { return { status: 400, body: safeError("range", e) }; }
  const { snap } = parsed;
  const range = snap.kind === "fytd"
    ? { kind: "fytd" }
    : snap.kind === "period"
      ? { kind: "period", period_no: snap.period_no }
      : { kind: "explicit", start: snap.start, end: snap.end };

  // Resolve the Overview payload.
  let payload;
  try {
    payload = await resolveOverview({
      supa,
      accountKey: account,
      range,
      includeSalary,
      caller: { ...caller, can_see_salary: salaryAvailable },
      today,
      now,
      fy: fiscalYear,
      debugTiming,
      regionalDirectorEastDisplay,
      regionalDirectorWestDisplay,
    });
  } catch (e) {
    return { status: 500, body: safeError("resolve_overview", e) };
  }
  if (payload?.error) {
    return { status: 500, body: safeError(payload.scope || "resolve_overview", payload.error) };
  }
  payload.preview_account = preview_account;
  payload.landing_account = landing_account;
  if (caller?.role === "corporate") {
    payload.export = { available: true, scope: "all" };
  } else if (caller?.role === "site_leader" && caller.scope) {
    payload.export = { available: true, scope: caller.scope };
  } else {
    payload.export = { available: false };
  }
  if (snap.snapped) {
    payload.range_snap = {
      snapped: true,
      snapped_from: snap.snapped_from,
      snapped_to: { start: snap.start, end: snap.end, period_no: snap.period_no },
    };
  }
  payload.todayISO = today;
  return { status: 200, body: payload };
}

// ─── getLabor ──────────────────────────────────────────────────────
//
// Port of v1 src/app/api/kpi/labor/route.js GET handler. Clock reads
// INSIDE helper bodies stay as v1 has them (commit 2 sweeps those);
// commit 1 only wires at the ENTRY boundary.

const LABOR_D26_SALARIED_ONLY = new Set(["CIN - KY", "TBJ - NY"]);
const LABOR_D17_OUT_OF_SCOPE = new Set(["CORP"]);

// Train 2c: paged via pagedSelect. accounts.team_key is the PK so
// the sort is unique.
async function fetchAccountsDirectoryLabor(supa: any): Promise<any> {
  const q = await pagedSelect((from: number, to: number) => supa
    .from("accounts")
    .select("team_key, region, name, city, state, timezone")
    .neq("team_key", "CORP")
    .neq("active", false)
    .order("team_key")
    .range(from, to));
  if (q.error) return { error: q.error };
  const salaried = new Set(["CIN - KY", "TBJ - NY"]);
  return {
    data: (q.data || []).map((r: any) => ({
      team_key: r.team_key,
      region: r.region,
      team_name: r.name || null,
      city: r.city || null,
      state: r.state || null,
      timezone: r.timezone || null,
      salaried: salaried.has(r.team_key),
    })),
  };
}

export async function getLabor({
  supa, today, now, fiscalYear, caller, query,
  regionalDirectorEastDisplay, regionalDirectorWestDisplay,
}: any): Promise<{ status: number; body: any }> {
  const q: any = query || {};
  let account = (q.account || "").trim();
  const previewParam = (q.preview || "").trim();
  // Range inputs with FY start default + today fallback.
  let start = (q.start || "").trim() || fiscalYear.startISO;
  let end = (q.end || "").trim() || today;
  // Snap any non-aligned (start, end) to the fiscal period containing end.
  const _labSnap: any = snapRange(start, end, today, fiscalYear);
  const _labSnapped = _labSnap.snapped;
  const _labSnappedFrom = _labSnap.snapped_from;
  start = _labSnap.start;
  end = _labSnap.end;
  let is_future_range = start > today;
  const pageSizeParam = parseInt(String(q._page_size || "0"), 10);
  const includeSalaryReq = q.include_salary === "1" || q.include_salary === true;
  const wantWorkerRates = q.rates === "1";
  const homestandParam = (q.homestand || "").trim() || null;

  if (!caller) return { status: 403, body: { error: "forbidden" } };

  // Accounts directory in parallel with (no role gate call - caller is passed in).
  const dirQ: any = await fetchAccountsDirectoryLabor(supa);
  if (dirQ.error) return { status: 500, body: safeErrorLabor("accounts_directory", dirQ.error) };

  const landing_account = landingAccount(caller);

  // Preview mode - preview only NARROWS access.
  const preview: any = resolvePreviewAccess({
    caller,
    canViewAccount,
    urlAccount: account,
    previewParam,
  });
  account = preview.account;
  const preview_account = preview.preview_account;

  const accounts_directory = dirQ.data;
  const regional_directors_display = {
    East: regionalDirectorEastDisplay ?? null,
    West: regionalDirectorWestDisplay ?? null,
  };

  // Empty account -> landing response.
  if (!account) {
    return {
      status: 200,
      body: {
        landing_account,
        preview_account,
        accounts_directory,
        regional_directors_display,
      },
    };
  }
  if (LABOR_D17_OUT_OF_SCOPE.has(account)) {
    return { status: 400, body: { error: "account_out_of_scope", account } };
  }

  // Locked-state response.
  if (!canViewAccount(caller, account)) {
    return {
      status: 200,
      body: {
        locked: true,
        account,
        reason: "not_authorised",
        landing_account,
        preview_account,
        accounts_directory,
        regional_directors_display,
      },
    };
  }

  // Preamble batch: psWalkGlobal, weeklyMax, dailyMax, daily floor.
  // Train 2c: each read is `.maybeSingle()` (one row by definition) so
  // all four are exempt from pagedSelect.
  const [psWalkGlobal, weeklyMaxQ, dailyMaxQ, floorQ]: any = await Promise.all([
    supa.from("rippling_walks")
      .select("completed_at")
      .eq("kind", "pay_segments")
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa.from("labor_actuals").select("derived_at")
      .gte("week_start", fiscalYear.startISO).lte("week_start", fiscalYear.endISO)
      .order("derived_at", { ascending: false }).limit(1).maybeSingle(),
    supa.from("labor_actuals_daily").select("derived_at")
      .gte("week_start", fiscalYear.startISO).lte("week_start", fiscalYear.endISO)
      .order("derived_at", { ascending: false }).limit(1).maybeSingle(),
    supa.from("labor_actuals")
      .select("week_start")
      .eq("week_source", "sc_day_metadata")
      .gte("week_start", fiscalYear.startISO).lte("week_start", fiscalYear.endISO)
      .order("week_start")
      .limit(1)
      .maybeSingle(),
  ]);

  const freshness: any = {
    last_walk_at: psWalkGlobal.data?.completed_at || null,
    last_derive_at: null,
    last_weekly_derive_at: weeklyMaxQ.data?.derived_at || null,
    last_daily_derive_at: dailyMaxQ.data?.derived_at || null,
  };

  const salary_available = canSeeSalary(caller, account);
  const includeSalary = includeSalaryReq && salary_available;
  const mergeSalary = salary_available && includeSalary;

  if (floorQ.error) return { status: 500, body: safeErrorLabor("daily_floor", floorQ.error) };
  // Train 2c: rule date (daily-labor floor) kept via DOLLAR_COVERAGE_FLOOR
  // from src/lib/kpi/floors.ts. Not a fiscal-year date.
  const dailyFloorISO = floorQ.data?.week_start || DOLLAR_COVERAGE_FLOOR;

  // Homestand branch.
  let homestandSplice: any = null;
  let allHomestands: any = null;
  let homestandBank: any = null;
  let homestandGameDatesByStand: any = null;
  try { allHomestands = await listHomestands(supa, account, fiscalYear, { includeSalary: mergeSalary }); }
  catch (e: any) { return { status: 500, body: safeErrorLabor("homestand_list", e) }; }
  if (allHomestands && allHomestands.length > 0) {
    // Train 2c: paged via pagedSelect. labor_actuals_daily grain
    // (account_key, worker_id, work_date, line_code) - account_key
    // fixed. sc_homestand_schedule grain (account_key, service_date) -
    // account_key fixed.
    let dailyRows: any, schedRows: any;
    try {
      const [dR, sR]: any = await Promise.all([
        pagedSelect((from: number, to: number) => supa
          .from("labor_actuals_daily")
          .select("work_date, amount, hours_regular, hours_overtime, dollars_overtime, worker_id, line_code")
          .eq("account_key", account)
          .order("work_date")
          .order("worker_id")
          .order("line_code")
          .range(from, to)),
        pagedSelect((from: number, to: number) => supa
          .from("sc_homestand_schedule")
          .select("service_date, day_type, day_night, game_time, opponent")
          .eq("account_key", account)
          .order("service_date")
          .range(from, to)),
      ]);
      if (dR.error) throw new Error(`labor_actuals_daily: ${dR.error.message}`);
      if (sR.error) throw new Error(`sc_homestand_schedule: ${sR.error.message}`);
      dailyRows = dR.data;
      schedRows = sR.data;
    } catch (e: any) {
      return { status: 500, body: safeErrorLabor("homestand_daily_or_schedule", { message: e.message }) };
    }

    const hourlyActMap: any = actualsByStand(allHomestands, dailyRows);
    const actMap = new Map<any, any>(hourlyActMap);
    const salaryX10000ByStand = new Map<any, any>();
    if (mergeSalary) {
      const salActuals: any = await loadSalaryActuals(supa, [account], fiscalYear.startISO, fiscalYear.endISO);
      if (salActuals.error) return { status: 500, body: safeErrorLabor("homestand_salary_actuals", { message: salActuals.error }) };
      for (const h of allHomestands) {
        if (h.pre_floor) continue;
        const pr: any = salaryProRate({
          startISO: h.window_start,
          endISO: h.window_end,
          salaryRows: salActuals.rows || [],
        });
        const salX10000 = Math.round((pr.total || 0) * 10000);
        salaryX10000ByStand.set(h.game_start, salX10000);
        actMap.set(h.game_start, (actMap.get(h.game_start) || 0) + salX10000);
      }
    }
    allHomestands = allHomestands.map((h: any) => {
      const hourlyX = hourlyActMap.get(h.game_start) || 0;
      const salX = salaryX10000ByStand.get(h.game_start) || 0;
      const totalX = actMap.get(h.game_start) || 0;
      return {
        ...h,
        actual: (h.pre_floor || h.game_end > today) ? null : Math.round(totalX / 100) / 100,
        actual_hourly: (h.pre_floor || h.game_end > today) ? null : Math.round(hourlyX / 100) / 100,
        actual_salary: (h.pre_floor || h.game_end > today || !includeSalary) ? null : Math.round(salX / 100) / 100,
      };
    });
    homestandBank = computeHomestandBank(allHomestands, actMap, today);

    try {
      allHomestands = await foldPreFloorEstimates(supa, account, allHomestands, dailyFloorISO, today);
    } catch (e: any) {
      return { status: 500, body: safeErrorLabor("pre_floor_estimator", e) };
    }
    try {
      allHomestands = await foldPerStandSplits(supa, account, allHomestands, schedRows, today);
    } catch (e: any) {
      return { status: 500, body: safeErrorLabor("per_stand_splits", e) };
    }

    homestandGameDatesByStand = new Map();
    for (const h of allHomestands) {
      if (h.pre_floor) continue;
      const gameDates = new Set(
        schedRows
          .filter((r: any) => r.day_type === "GAME" && r.service_date >= h.game_start && r.service_date <= h.game_end)
          .map((r: any) => r.service_date)
      );
      homestandGameDatesByStand.set(h.game_start, gameDates);
    }

    if (homestandParam) {
      const found: any = allHomestands.find((x: any) => x.game_start === homestandParam);
      if (!found) {
        return {
          status: 200,
          body: {
            source: null,
            refused: true,
            message: `That homestand does not exist for ${account}. Pick a stand from the rail above.`,
            homestand: null,
            homestand_param: homestandParam,
            homestands: allHomestands,
            homestand_bank: homestandBank,
            daily_floor: dailyFloorISO,
            account, filters: { account, homestand: homestandParam },
            landing_account, preview_account, accounts_directory, regional_directors_display,
            salary_available,
          },
        };
      }
      if (found.pre_floor) {
        return {
          status: 200,
          body: {
            source: "estimated",
            refused: false,
            homestand: found,
            homestand_estimated: found.is_estimated ? {
              total: found.actual_estimated,
              per_day: found.estimator_meta?.per_day || [],
              base_rates: found.estimator_meta?.base_rates || null,
              source_stands: found.estimator_meta?.source_stands || 0,
              method: "game_day_weighted",
              note: "Estimated: this stand is before daily detail started (04/20/26). Each week's real total is distributed across days by what the schedule says happened (night game, day game, prep day). Derived from the account's own low-OT stands.",
            } : null,
            daily_floor: dailyFloorISO,
            homestands: allHomestands,
            homestand_bank: homestandBank,
            account, filters: { account, homestand: homestandParam },
            landing_account, preview_account, accounts_directory, regional_directors_display,
            salary_available: false,
          },
        };
      }
      start = found.window_start;
      end = found.window_end;
      is_future_range = start > today;
      const gameDatesForFound: any = homestandGameDatesByStand.get(found.game_start) || new Set();
      const nightDatesForFound = new Set(
        schedRows
          .filter((r: any) => r.day_type === "GAME" && r.day_night === "night"
            && r.service_date >= found.game_start && r.service_date <= found.game_end)
          .map((r: any) => r.service_date)
      );
      const schedByDate = new Map();
      for (const r of schedRows) {
        if (r.day_type !== "GAME") continue;
        if (r.service_date < found.game_start || r.service_date > found.game_end) continue;
        schedByDate.set(r.service_date, {
          date: r.service_date,
          opponent: r.opponent || null,
          day_night: r.day_night || null,
          game_time: r.game_time || null,
        });
      }
      homestandSplice = {
        homestand: found,
        homestand_game_dates: [...gameDatesForFound].sort(),
        homestand_night_dates: [...nightDatesForFound].sort(),
        homestand_schedule: [...schedByDate.values()].sort((a: any, b: any) => a.date.localeCompare(b.date)),
        homestand_split: found.split || null,
      };
      if (found.actual_estimated != null) {
        const isPlayed = !found.is_estimated;
        homestandSplice.homestand_estimated = {
          total: found.actual_estimated,
          per_day: found.estimator_meta?.per_day || [],
          base_rates: found.estimator_meta?.base_rates || null,
          source_stands: found.estimator_meta?.source_stands || 0,
          method: "game_day_weighted",
          note: found.pre_floor
            ? "Estimated: this stand is before daily detail started (04/20/26). Each week's real total is distributed across days by what the schedule says happened (night game, day game, prep day). Derived from the account's own low-OT stands."
            : isPlayed
              ? "Retrospective plan: the account's low-OT weekly totals distributed across this stand's days by night/day/prep weights. Compares what the plan would have said against what the stand actually cost."
              : "Estimated: this stand's games have not been played yet. Each day is priced at the account's base rate for that day type (night game, day game, prep day). Derived from the account's own low-OT played stands.",
        };
      }
    }
  }
  const homestandsList = allHomestands || [];

  let rangeSource: any = resolveRangeSource({ startISO: start, endISO: end, dailyFloorISO });

  if (homestandParam && start >= dailyFloorISO && rangeSource.source !== "daily") {
    rangeSource = {
      source: "daily",
      reason: "homestand_view_forces_daily",
      isWholeWeeks: rangeSource.isWholeWeeks,
      isPartialWeek: rangeSource.isPartialWeek,
      spanDays: rangeSource.spanDays,
      refused: false,
    };
  }

  if (rangeSource.refused) {
    return {
      status: 200,
      body: {
        source: null,
        refused: true,
        reason: rangeSource.reason,
        message: rangeSource.refusalMessage,
        daily_floor: dailyFloorISO,
        account,
        filters: { account, start, end },
        landing_account,
        preview_account,
        accounts_directory,
        regional_directors_display,
        salary_available: false,
        homestands: homestandsList,
        homestand_bank: homestandBank,
      },
    };
  }

  // Daily branch.
  if (rangeSource.source === "daily") {
    const out: any = await buildDailyRangeBody({
      supa, account, start, end, today,
      caller, landing_account, preview_account,
      accounts_directory, regional_directors_display,
      freshness,
      rangeSource,
      dailyFloorISO,
      salary_available, includeSalary,
      resolveWorkerMeta,
      is_future_range,
      homestandSplice, homestandsList, homestandBank,
      previewParam,
      fy: fiscalYear,
    });
    if (out.error) return { status: out.error.status, body: out.error.payload };
    const body: any = { ...out.body };
    if (homestandsList) body.homestands = homestandsList;
    if (homestandBank) body.homestand_bank = homestandBank;
    if (homestandSplice) Object.assign(body, homestandSplice);
    if (typeof is_future_range === "boolean") body.is_future_range = is_future_range;
    if (today) body.todayISO = today;
    return { status: 200, body };
  }

  // Aggregate pseudo-keys (ALL / EAST / WEST).
  if (V6_PSEUDO_KEYS.has(account)) {
    const memberQ: any = await resolvePortfolioMembers(supa, account);
    if (memberQ.error) return { status: 500, body: safeErrorLabor("v6_members", memberQ.error) };
    const members: any = memberQ.data.map((r: any) => r.team_key);
    if (members.length === 0) {
      return { status: 400, body: { error: "no_members_in_region", account } };
    }
    const canonAcct = members[0];
    // Train 2c paged reads below:
    //   sc_day_metadata grain (account_key, service_date) - account_key
    //     fixed so service_date is unique.
    //   labor_unattributed grain (reason_code, department_id,
    //     worker_id, first_seen_date, line_code) - (worker_id,
    //     first_seen_date, reason_code, department_id) orders uniquely
    //     in practice; add `id` tie-breaker if row grain expands.
    //   earning_type_unmapped grain (merged_earning_type_name) -
    //     unique per row.
    let aQ: any, periodDays: any, unattrRowsAgg: any, unmapped: any, memberBudgetResults: any;
    try {
      [aQ, periodDays, unattrRowsAgg, unmapped, memberBudgetResults] = await Promise.all([
        paginateLaborActuals(supa, { members, start, end, pageSize: pageSizeParam }),
        pagedSelect((from: number, to: number) => supa
          .from("sc_day_metadata")
          .select("service_date, period")
          .eq("account_key", canonAcct)
          .gte("service_date", fiscalYear.startISO)
          .lte("service_date", fiscalYear.endISO)
          .not("period", "is", null)
          .order("service_date")
          .range(from, to)),
        pagedSelect((from: number, to: number) => supa
          .from("labor_unattributed")
          .select("reason_code, department_id, worker_id, amount, hours, segment_count, first_seen_date, last_seen_date, derived_at, notes")
          .order("amount", { ascending: false })
          .order("worker_id")
          .order("first_seen_date")
          .order("reason_code")
          .order("department_id")
          .range(from, to)),
        pagedSelect((from: number, to: number) => supa
          .from("earning_type_unmapped")
          .select("merged_earning_type_name, occurrence_count, total_hours, total_amount, first_seen_at, last_seen_at, resolved_at")
          .is("resolved_at", null)
          .order("total_amount", { ascending: false })
          .order("merged_earning_type_name")
          .range(from, to)),
        resolveMemberBudgets(supa, members, fiscalYear),
      ]);
    } catch (e: any) {
      return { status: 500, body: safeErrorLabor("labor_aggregate_loaders", { message: e.message }) };
    }
    if (aQ.error) return { status: 500, body: safeErrorLabor("labor_actuals_aggregate", aQ.error) };
    const actualsRows: any = aQ.data;
    if (periodDays.error) return { status: 500, body: safeErrorLabor("sc_day_metadata_period_bounds_aggregate", periodDays.error) };
    if (unattrRowsAgg.error) return { status: 500, body: safeErrorLabor("labor_unattributed_aggregate", unattrRowsAgg.error) };
    if (unmapped.error) return { status: 500, body: safeErrorLabor("earning_type_unmapped_aggregate", unmapped.error) };
    for (const [, r] of memberBudgetResults as any) {
      if (r?.error) return { status: 500, body: safeErrorLabor(r.scope, r.error) };
    }

    const periodBounds = new Map<any, any>();
    for (const r of periodDays.data || []) {
      const p = String(r.period);
      const cur: any = periodBounds.get(p);
      if (!cur) periodBounds.set(p, { start: r.service_date, end: r.service_date });
      else {
        if (r.service_date < cur.start) cur.start = r.service_date;
        if (r.service_date > cur.end) cur.end = r.service_date;
      }
    }
    const account_periods = [...periodBounds.entries()]
      .map(([p, b]: any) => ({ fiscal_year: fiscalYear.year, period_no: parseInt(p, 10), start: b.start, end: b.end }))
      .sort((a: any, b: any) => a.period_no - b.period_no);

    const unattr: any = { data: unattrRowsAgg.data || [] };

    const memberBudgets = new Map<any, any>();
    for (const m of members) {
      memberBudgets.set(m, memberBudgetResults.get(m)?.data || []);
    }
    const perPeriodAgg = new Map<any, any>();
    for (const [m, list] of memberBudgets as any) {
      for (const bp of list) {
        const cur: any = perPeriodAgg.get(bp.period_no) || { amount: 0, superseded: false, member_detail: [] };
        cur.amount += Number(bp.amount);
        if (bp.superseded) cur.superseded = true;
        cur.member_detail.push({
          account_key: m,
          amount: bp.amount,
          source: bp.source,
          basis: bp.basis,
          superseded: !!bp.superseded,
          ...(bp.reason ? { reason: bp.reason } : {}),
        });
        perPeriodAgg.set(bp.period_no, cur);
      }
    }
    const budget_periods = [...perPeriodAgg.entries()]
      .sort((a: any, b: any) => a[0] - b[0])
      .map(([p, v]: any) => ({
        period_no: p,
        amount: Math.round(v.amount * 100) / 100,
        source: v.superseded ? "supersede" : "pnl",
        superseded: v.superseded,
        member_detail: v.member_detail.sort((a: any, b: any) => a.account_key.localeCompare(b.account_key)),
      }));

    const rolledUpMembers = members;
    const rolledUpActuals = actualsRows;

    const workerIds = [...new Set(actualsRows.map((r: any) => r.worker_id))];
    let workerMeta: any, resolvedNames: any, usersReachable: any, priorCmpAgg: any, workerWeekRatesAgg: any;
    try {
      const [workerRes, priorRes, ratesRes]: any = await Promise.all([
        resolveWorkerMeta(supa, workerIds),
        buildPriorPeriodComparison({
          supa, rangeStart: start, rangeEnd: end, today,
          isAggregate: true, members: rolledUpMembers,
          currentActuals: rolledUpActuals, pageSize: pageSizeParam,
          fy: fiscalYear,
        }),
        wantWorkerRates
          ? loadWorkerWeekRates(supa, { actualsRows })
          : Promise.resolve({ rates: new Map(), mixedRaiseWeeks: 0, workerWeeksCount: 0 }),
      ]);
      ({ workerMeta, resolvedNames, usersReachable } = workerRes);
      priorCmpAgg = priorRes;
      workerWeekRatesAgg = ratesRes;
    } catch (e: any) {
      return { status: 500, body: safeErrorLabor("workerMeta_or_prior_or_rates", { message: e.message }) };
    }
    if (priorCmpAgg?.error) return { status: 500, body: safeErrorLabor(priorCmpAgg.scope, priorCmpAgg.error) };

    const workerToEmail = buildWorkerToEmail(workerMeta);
    let body: any = {
      ok: true,
      filters: { account, start, end },
      account_state: "hourly_ok",
      actuals: actualsRows,
      unattributed: (unattr.data || []).filter(() => true),
      workers: workerMeta,
      worker_week_rates: Object.fromEntries(workerWeekRatesAgg.rates),
      derive_freshness: {
        last_walk_at: freshness.last_walk_at,
        last_derive_at: actualsRows.reduce(
          (max: any, r: any) => (r.derived_at && (!max || r.derived_at > max) ? r.derived_at : max),
          null
        ),
        last_weekly_derive_at: freshness.last_weekly_derive_at,
        last_daily_derive_at: freshness.last_daily_derive_at,
      },
      unmapped_names: unmapped.data || [],
      account_periods,
      budget_periods,
      members,
      rolled_up_members: rolledUpMembers,
      accounts_directory,
      regional_directors_display,
      board: buildBoard({
        account, start, end, today,
        actuals: rolledUpActuals,
        budget_periods,
        account_state: "hourly_ok",
        workerToEmail,
        fy: fiscalYear,
      } as any),
      week_budgets: buildAggregateWeekBudgets({ start, end, member_budgets: memberBudgets, fy: fiscalYear }),
      prior_period_comparison: priorCmpAgg,
      name_availability: {
        has_names: resolvedNames > 0,
        resolved: resolvedNames,
        total: workerIds.length,
        reason: resolvedNames === workerIds.length && workerIds.length > 0
          ? "all_resolved_from_users_endpoint"
          : !usersReachable
            ? "users_table_empty_or_unreachable"
            : "some_workers_lack_user_id_or_canonical_name",
      },
    };
    Object.assign(body, pinHourlyOnly(body.board));
    if (mergeSalary) {
      const [budQ, actQ]: any = await Promise.all([
        load3100_2Budgets(supa, members, fiscalYear),
        loadSalaryActuals(supa, members, start, end),
      ]);
      if (budQ.error) return { status: 500, body: safeErrorLabor("kpi_budgets_3100_2", budQ.error) };
      if (actQ.error) return { status: 500, body: safeErrorLabor("labor_salary_actuals", actQ.error) };
      const salaryOnlyIds = [...new Set(actQ.rows.map((r: any) => r.worker_id))]
        .filter((id: any) => id && !body.workers[id]);
      let mergedWorkerToEmail = workerToEmail;
      if (salaryOnlyIds.length > 0) {
        const extra: any = await resolveWorkerMeta(supa, salaryOnlyIds);
        body.workers = { ...body.workers, ...extra.workerMeta };
        mergedWorkerToEmail = buildWorkerToEmail(body.workers);
      }
      body = withSalaryMerge(body, {
        account, members, start, end, today,
        buildBoard,
        buildWeekBudgets,
        salary3100_2: budQ.byAccount,
        salaryRows: actQ.rows,
        workerToEmail: mergedWorkerToEmail,
        fy: fiscalYear,
      } as any);
    }
    body.salary_available = salary_available;
    body.salary_included = includeSalary;
    body.landing_account = landing_account;
    body.preview_account = preview_account;
    body.source = "weekly";
    body.is_future_range = is_future_range;
    body.todayISO = today;
    return { status: 200, body };
  }

  // D26 salaried-only accounts.
  if (LABOR_D26_SALARIED_ONLY.has(account)) {
    let bodyD26: any = {
      ok: true,
      filters: { account, start, end },
      account_state: "salaried_only",
      actuals: [],
      unattributed: [],
      workers: {},
      derive_freshness: freshness,
      unmapped_names: [],
      account_periods: [],
      accounts_directory,
      regional_directors_display,
      name_availability: { has_names: false, resolved: 0, total: 0, reason: "salaried_only" },
      board: buildBoard({
        account, start, end, today,
        actuals: [],
        budget_periods: [],
        account_state: "salaried_only",
        fy: fiscalYear,
      } as any),
      week_budgets: [],
    };
    Object.assign(bodyD26, pinHourlyOnly(bodyD26.board));
    if (mergeSalary) {
      const [budQ, actQ]: any = await Promise.all([
        load3100_2Budgets(supa, [account], fiscalYear),
        loadSalaryActuals(supa, [account], start, end),
      ]);
      if (budQ.error) return { status: 500, body: safeErrorLabor("kpi_budgets_3100_2", budQ.error) };
      if (actQ.error) return { status: 500, body: safeErrorLabor("labor_salary_actuals", actQ.error) };
      bodyD26.account_state = "hourly_ok";
      const salaryOnlyIds = [...new Set(actQ.rows.map((r: any) => r.worker_id))]
        .filter((id: any) => id && !bodyD26.workers[id]);
      let d26WorkerToEmail = new Map();
      if (salaryOnlyIds.length > 0) {
        const extra: any = await resolveWorkerMeta(supa, salaryOnlyIds);
        bodyD26.workers = { ...bodyD26.workers, ...extra.workerMeta };
        d26WorkerToEmail = buildWorkerToEmail(bodyD26.workers);
      }
      bodyD26 = withSalaryMerge(bodyD26, {
        account, members: [account], start, end, today,
        buildBoard,
        buildWeekBudgets,
        salary3100_2: budQ.byAccount,
        salaryRows: actQ.rows,
        workerToEmail: d26WorkerToEmail,
        fy: fiscalYear,
      } as any);
      const d26RangePeriods: any[] = [];
      {
        const weekStarts: any = weekStartsInRange(start, end, fiscalYear);
        const seen = new Set();
        for (const w of weekStarts) {
          const p = periodOfLabor(w, fiscalYear);
          if (p != null && !seen.has(p)) { seen.add(p); d26RangePeriods.push(p); }
        }
      }
      const [d26Pnl, d26Status]: any = await Promise.all([
        loadPnlActuals(supa, { members: [account], periods: d26RangePeriods, fiscalYear: fiscalYear.year } as any),
        loadPeriodStatus(supa, fiscalYear.year as any),
      ]);
      const d26PnlMap = d26Pnl?.data || new Map();
      const d26StatusMap = d26Status?.data || new Map();
      const d26Feed3100 = new Map();
      for (const w of (bodyD26.board?.weeks || [])) {
        if (!w.week_start || w.spent == null) continue;
        const p: any = periodOfLabor(w.week_start, fiscalYear);
        if (p == null || !d26RangePeriods.includes(p)) continue;
        d26Feed3100.set(p, (d26Feed3100.get(p) || 0) + Number(w.spent || 0));
      }
      const d26FinanceClose: any = resolveFinanceCloseAdjustment({
        accountKeys: [account],
        periods: d26RangePeriods,
        periodStatus: d26StatusMap,
        todayISO: today,
        pnlMap: d26PnlMap,
        feedByParentPeriod: new Map<any, any>([
          ["3100", d26Feed3100],
          ["3200", new Map()], ["3400", new Map()], ["3500", new Map()],
        ]),
      } as any);
      applyFinanceCloseToLaborBoard(bodyD26.board, d26FinanceClose);
    }
    bodyD26.salary_available = salary_available;
    bodyD26.salary_included = includeSalary;
    bodyD26.landing_account = landing_account;
    bodyD26.preview_account = preview_account;
    bodyD26.source = "weekly";
    bodyD26.is_future_range = is_future_range;
    bodyD26.todayISO = today;
    return { status: 200, body: bodyD26 };
  }

  // Single-account weekly path.
  // Train 2c paged reads:
  //   labor_actuals_latest grain (account_key, worker_id, week_start)
  //     - account_key fixed so (week_start, worker_id) is unique.
  //   labor_unattributed grain - ordered by (amount desc, worker_id,
  //     first_seen_date, reason_code, department_id).
  //   sc_day_metadata grain (account_key, service_date) - account_key
  //     fixed so service_date is unique.
  //   earning_type_unmapped - merged_earning_type_name is unique per row.
  //   kpi_budgets PK (account_key, fiscal_year, period_no, line_code)
  //     - all three fixed so period_no is unique.
  //   sc_labor_budgets PK is the uuid id; sort chain
  //     (period, effective_from, id) is unique.
  let actualsRows: any, unattrRows: any, periodDays: any, unmapped: any, pnlQ: any, scQ: any;
  try {
    [actualsRows, unattrRows, periodDays, unmapped, pnlQ, scQ] = await Promise.all([
      pagedSelect((from: number, to: number) => supa
        .from("labor_actuals_latest")
        .select("account_key, worker_id, week_label, week_start, week_end, fiscal_year, hours_regular, hours_overtime, hours_double_time, hours_premium_other, dollars_regular, dollars_overtime, dollars_double_time, dollars_premium_other, amount, hours_without_dollars, coverage_state, draft_entry_count, draft_hours, anomaly_no_clockout, anomaly_under_1h, anomaly_over_16h, approved_hours, oldest_draft_date, still_costing_hours, derived_at")
        .eq("account_key", account)
        .lte("week_start", end)
        .gte("week_end", start)
        .order("week_start", { ascending: true })
        .order("worker_id", { ascending: true })
        .range(from, to)),
      pagedSelect((from: number, to: number) => supa
        .from("labor_unattributed")
        .select("reason_code, department_id, worker_id, amount, hours, segment_count, first_seen_date, last_seen_date, derived_at, notes")
        .order("amount", { ascending: false })
        .order("worker_id")
        .order("first_seen_date")
        .order("reason_code")
        .order("department_id")
        .range(from, to)),
      pagedSelect((from: number, to: number) => supa
        .from("sc_day_metadata")
        .select("service_date, period")
        .eq("account_key", account)
        .gte("service_date", fiscalYear.startISO)
        .lte("service_date", fiscalYear.endISO)
        .not("period", "is", null)
        .order("service_date")
        .range(from, to)),
      pagedSelect((from: number, to: number) => supa
        .from("earning_type_unmapped")
        .select("merged_earning_type_name, occurrence_count, total_hours, total_amount, first_seen_at, last_seen_at, resolved_at")
        .is("resolved_at", null)
        .order("total_amount", { ascending: false })
        .order("merged_earning_type_name")
        .range(from, to)),
      pagedSelect((from: number, to: number) => supa
        .from("kpi_budgets")
        .select("period_no, amount")
        .eq("account_key", account)
        .eq("line_code", "3100.1")
        .eq("fiscal_year", fiscalYear.year)
        .order("period_no")
        .range(from, to)),
      pagedSelect((from: number, to: number) => supa
        .from("sc_labor_budgets")
        .select("period, hourly_budget, reason, id, effective_from")
        .eq("account_key", account)
        .is("superseded_at", null)
        .gte("effective_from", fiscalYear.startISO)
        .lte("effective_from", fiscalYear.endISO)
        .order("period")
        .order("effective_from")
        .order("id")
        .range(from, to)),
    ]);
  } catch (e: any) {
    return { status: 500, body: safeErrorLabor("labor_actuals", { message: e.message }) };
  }
  if (actualsRows.error) return { status: 500, body: safeErrorLabor("labor_actuals_latest", actualsRows.error) };
  if (unattrRows.error) return { status: 500, body: safeErrorLabor("labor_unattributed", unattrRows.error) };
  const actuals: any = { data: actualsRows.data };
  const unattr: any = { data: unattrRows.data };
  if (periodDays.error) return { status: 500, body: safeErrorLabor("sc_day_metadata_period_bounds_single", periodDays.error) };
  if (unmapped.error) return { status: 500, body: safeErrorLabor("earning_type_unmapped", unmapped.error) };
  if (pnlQ.error) return { status: 500, body: safeErrorLabor("kpi_budgets_3100_1", pnlQ.error) };
  if (scQ.error) return { status: 500, body: safeErrorLabor("sc_labor_budgets", scQ.error) };

  const periodBounds = new Map<any, any>();
  for (const r of periodDays.data || []) {
    const p = String(r.period);
    const cur: any = periodBounds.get(p);
    if (!cur) periodBounds.set(p, { start: r.service_date, end: r.service_date });
    else {
      if (r.service_date < cur.start) cur.start = r.service_date;
      if (r.service_date > cur.end) cur.end = r.service_date;
    }
  }
  const account_periods = [...periodBounds.entries()]
    .map(([p, b]: any) => ({ fiscal_year: fiscalYear.year, period_no: parseInt(p, 10), start: b.start, end: b.end }))
    .sort((a: any, b: any) => a.period_no - b.period_no);

  const derive_freshness: any = {
    last_walk_at: freshness.last_walk_at,
    last_derive_at: (actuals.data || []).reduce(
      (max: any, r: any) => (r.derived_at && (!max || r.derived_at > max) ? r.derived_at : max),
      null
    ),
    last_weekly_derive_at: freshness.last_weekly_derive_at,
    last_daily_derive_at: freshness.last_daily_derive_at,
  };

  const isRevenueFlexAcct = V37_REVENUE_FLEX_ACCOUNTS.has(account);
  let budget_periods: any[] = [];
  {
    const pnlByPeriod = new Map((pnlQ.data || []).map((r: any) => [Number(r.period_no), Number(r.amount)]));
    const scByPeriod = new Map(
      (scQ.data || []).map((r: any) => [parseInt(String(r.period), 10), {
        amount: Number(r.hourly_budget),
        reason: r.reason || null,
      }])
    );

    for (let p = 1; p <= 13; p += 1) {
      const sc: any = scByPeriod.get(p);
      const pnl: any = pnlByPeriod.get(p);
      if (sc != null && Number.isFinite(sc.amount)) {
        const pnlDiffers = pnl != null && Math.abs(pnl - sc.amount) > 0.01;
        budget_periods.push({
          period_no: p,
          amount: Math.round(sc.amount * 100) / 100,
          source: "supersede",
          basis: isRevenueFlexAcct ? "envelope" : "pnl",
          superseded: pnlDiffers,
          ...(sc.reason ? { reason: sc.reason } : {}),
          ...(pnlDiffers ? { pnl_amount: Math.round(pnl * 100) / 100 } : {}),
        });
      } else if (pnl != null && Number.isFinite(pnl)) {
        budget_periods.push({
          period_no: p,
          amount: Math.round(pnl * 100) / 100,
          source: "pnl",
          basis: "pnl",
          superseded: false,
        });
      }
    }
  }

  const workerIds = [...new Set(actuals.data.map((r: any) => r.worker_id))];
  let workerMeta: any, resolvedNames: any, usersReachable: any, priorCmpSingle: any, workerWeekRatesSingle: any;
  try {
    const [workerRes, priorRes, ratesRes]: any = await Promise.all([
      resolveWorkerMeta(supa, workerIds),
      buildPriorPeriodComparison({
        supa, rangeStart: start, rangeEnd: end, today,
        isAggregate: false, account,
        currentActuals: actuals.data,
        fy: fiscalYear,
      }),
      wantWorkerRates
        ? loadWorkerWeekRates(supa, { actualsRows: actuals.data })
        : Promise.resolve({ rates: new Map(), mixedRaiseWeeks: 0, workerWeeksCount: 0 }),
    ]);
    ({ workerMeta, resolvedNames, usersReachable } = workerRes);
    priorCmpSingle = priorRes;
    workerWeekRatesSingle = ratesRes;
  } catch (e: any) {
    return { status: 500, body: safeErrorLabor("workerMeta_or_prior_or_rates_single", { message: e.message }) };
  }
  if (priorCmpSingle?.error) return { status: 500, body: safeErrorLabor(priorCmpSingle.scope, priorCmpSingle.error) };
  const workerToEmail = buildWorkerToEmail(workerMeta);

  const rangePeriodsSingle = (account_periods || [])
    .filter((p: any) => p.start && p.end && p.start <= end && p.end >= start)
    .map((p: any) => p.period_no);
  const closedPeriodsSingle = periodsClosedBefore(rangePeriodsSingle, today, fiscalYear);
  const closedLaborBudgetSingle = (budget_periods || [])
    .filter((bp: any) => closedPeriodsSingle.includes(bp.period_no))
    .reduce((s: number, bp: any) => s + Number(bp.amount || 0), 0);
  const revenueBasisPromiseSingle: any = loadRangeRevenueBasis(supa, {
    members: [account],
    periods: closedPeriodsSingle,
    start,
    end,
    today,
    fy: fiscalYear,
  });
  const [revenueBasisSingle, weeklyBasisSingle, overviewBudgetsSingle, pnlResp, periodStatusResp]: any = await Promise.all([
    revenueBasisPromiseSingle,
    loadWeeklyRevenueBasis(supa, { members: [account], start, end, today, fy: fiscalYear }),
    loadOverviewBudgets(supa, { members: [account] } as any),
    loadPnlActuals(supa, { members: [account], periods: rangePeriodsSingle, fiscalYear: fiscalYear.year } as any),
    loadPeriodStatus(supa, fiscalYear.year as any),
  ]);
  const pnlMapSingle = pnlResp?.data || new Map();
  const periodStatusMapSingle = periodStatusResp?.data || new Map();

  const applyFinanceCloseSingle = (b: any) => {
    if (!b || b.applies === false) return null;
    const feed3100 = new Map();
    for (const w of (b.weeks || [])) {
      if (!w.week_start || w.spent == null) continue;
      const p: any = periodOfLabor(w.week_start, fiscalYear);
      if (p == null || !rangePeriodsSingle.includes(p)) continue;
      feed3100.set(p, (feed3100.get(p) || 0) + Number(w.spent || 0));
    }
    const feedByParentPeriod = new Map<any, any>([
      ["3100", feed3100],
      ["3200", new Map()], ["3400", new Map()], ["3500", new Map()],
    ]);
    const financeClose: any = resolveFinanceCloseAdjustment({
      accountKeys: [account],
      periods: rangePeriodsSingle,
      periodStatus: periodStatusMapSingle,
      todayISO: today,
      pnlMap: pnlMapSingle,
      feedByParentPeriod,
    } as any);
    applyFinanceCloseToLaborBoard(b, financeClose);
    return financeClose;
  };

  const boardSingle: any = buildBoard({
    account, start, end, today,
    actuals: actuals.data,
    budget_periods,
    account_state: "hourly_ok",
    workerToEmail,
    fy: fiscalYear,
  } as any);
  attachBatrToBoard(boardSingle, revenueBasisSingle, {
    closedLaborBudget: closedLaborBudgetSingle,
    closedPeriods: closedPeriodsSingle,
    fy: fiscalYear,
  });
  const lineTargetPctSingle = computeLineTargetPctByPeriod({
    budgetPeriods: budget_periods,
    overviewBudgets: overviewBudgetsSingle?.data || new Map(),
    members: [account],
    periods: rangePeriodsSingle,
  });
  const contractualAccrualSingle = computeContractualAccrualByPeriod({
    overviewBudgets: overviewBudgetsSingle?.data || new Map(),
    members: [account],
    periods: rangePeriodsSingle,
  });
  const verifiedPeriodTotalsSingle = new Map();
  if (revenueBasisSingle.perPeriodRevenue) {
    for (const [pNo, entry] of revenueBasisSingle.perPeriodRevenue as any) {
      if (entry?.state === "verified") {
        verifiedPeriodTotalsSingle.set(pNo, sumPeriodRevenue(entry));
      }
    }
  }
  const feeBudgetByPeriodSingle = (() => {
    const perLine = (overviewBudgetsSingle?.data || new Map()).get("2300");
    const out = new Map();
    if (!perLine) return out;
    const byAcct = perLine.get(account);
    if (!byAcct) return out;
    for (const [pn, amt] of byAcct) out.set(pn, Number(amt || 0));
    return out;
  })();

  const salaryBudgetByPeriodHourly = new Map();
  const salaryBudRespShared: any = await load3100_2Budgets(supa, [account], fiscalYear);
  {
    const salaryBudResp: any = salaryBudRespShared;
    if (!salaryBudResp.error) {
      const byAcct = salaryBudResp.byAccount instanceof Map
        ? salaryBudResp.byAccount.get(account)
        : null;
      if (byAcct) {
        for (const [pn, amt] of byAcct) salaryBudgetByPeriodHourly.set(Number(pn), Number(amt || 0));
      }
    }
  }
  const mergedLineTargetPctHourly = computeMergedLineTargetPctByPeriod({
    mergedBudgetPeriods: (() => {
      const byP = new Map();
      for (const bp of (budget_periods || [])) {
        if (bp?.period_no != null) byP.set(Number(bp.period_no), Number(bp.amount || 0));
      }
      for (const [pn, s] of salaryBudgetByPeriodHourly) {
        byP.set(pn, (byP.get(pn) || 0) + Number(s || 0));
      }
      return [...byP.entries()].sort((a: any, b: any) => a[0] - b[0]).map(([period_no, amount]: any) => ({ period_no, amount }));
    })(),
    overviewBudgets: overviewBudgetsSingle?.data || new Map(),
    members: [account],
    periods: rangePeriodsSingle,
  });
  attachWeeklyBasisToBoard(boardSingle, weeklyBasisSingle, {
    lineTargetPctByPeriod: lineTargetPctSingle,
    mergedTargetPctByPeriod: mergedLineTargetPctHourly,
    todayISO: today,
    contractualAccrualByPeriod: contractualAccrualSingle,
    verifiedPeriodTotals: verifiedPeriodTotalsSingle,
    salaryBudgetByPeriod: salaryBudgetByPeriodHourly,
    feeBudgetByPeriod: feeBudgetByPeriodSingle,
    fy: fiscalYear,
  } as any);
  for (const w of (boardSingle.weeks || [])) {
    if (w.week_hourly_allowed != null) {
      w.budget_at_this_week_revenue = w.week_hourly_allowed;
    }
    if ("week_salary_allowed" in w) delete w.week_salary_allowed;
  }
  recomputePanelBatrFromPerWeek(boardSingle);
  if (boardSingle && boardSingle.kind === "multi_period"
    && boardSingle.applies !== false
    && revenueBasisSingle
    && Array.isArray(closedPeriodsSingle) && closedPeriodsSingle.length > 0) {
    const closedSalarySum = [...salaryBudgetByPeriodHourly.entries()]
      .filter(([p]: any) => closedPeriodsSingle.includes(p))
      .reduce((s: number, [, amt]: any) => s + Number(amt || 0), 0);
    const mergedRangeBudget = Number(closedLaborBudgetSingle || 0) + closedSalarySum;
    const mergedBatr: any = budgetAtThisRevenue({
      actualRevenue: revenueBasisSingle.totalRevenue,
      lineBudget: mergedRangeBudget,
      revenueBudgetFullPeriod: revenueBasisSingle.revenueBudgetFullPeriod,
      hasTarget: true,
    });
    if (mergedBatr != null) {
      const remainder = Math.round((mergedBatr - closedSalarySum) * 100) / 100;
      boardSingle.budget_at_this_revenue = remainder;
      if (boardSingle.closed_spent_to_date != null) {
        boardSingle.closed_variance = Math.round(
          (Number(boardSingle.closed_spent_to_date) - remainder) * 100
        ) / 100;
      }
    }
  }
  applyFinanceCloseSingle(boardSingle);
  if (boardSingle
    && boardSingle.applies !== false
    && boardSingle.finance_close_adjustment
    && Array.isArray(boardSingle.finance_close_adjustment.verified_periods)
    && boardSingle.finance_close_adjustment.verified_periods.length > 0) {
    const verifiedPeriods = boardSingle.finance_close_adjustment.verified_periods;
    const salaryActualsResp: any = await loadSalaryActuals(supa, [account], start, end);
    if (!salaryActualsResp.error) {
      const salaryByPeriod = new Map<any, any>();
      for (const r of (salaryActualsResp.rows || [])) {
        const p: any = r.week_start ? periodOfLabor(r.week_start, fiscalYear) : null;
        if (p == null || !verifiedPeriods.includes(p)) continue;
        salaryByPeriod.set(p, (salaryByPeriod.get(p) || 0) + Number(r.amount || 0));
      }
      let salaryOffsetTotal = 0;
      for (const [, amt] of salaryByPeriod) salaryOffsetTotal += Number(amt || 0);
      salaryOffsetTotal = Math.round(salaryOffsetTotal * 100) / 100;
      if (salaryOffsetTotal !== 0) {
        const fc = boardSingle.finance_close_adjustment;
        fc.total = Math.round((Number(fc.total || 0) - salaryOffsetTotal) * 100) / 100;
        fc.by_period = (fc.by_period || []).map((b: any) => ({
          period_no: b.period_no,
          amount: Math.round((Number(b.amount || 0) - Number(salaryByPeriod.get(b.period_no) || 0)) * 100) / 100,
        }));
        boardSingle.spent_to_date = Math.round(
          (Number(boardSingle.spent_to_date || 0) - salaryOffsetTotal) * 100
        ) / 100;
      }
    }
  }
  recomputeVerdictFromPanel(boardSingle);

  let bodySingle: any = {
    ok: true,
    filters: { account, start, end },
    account_state: "hourly_ok",
    actuals: actuals.data,
    unattributed: unattr.data.filter(() => true),
    workers: workerMeta,
    worker_week_rates: Object.fromEntries(workerWeekRatesSingle.rates),
    derive_freshness,
    unmapped_names: unmapped.data || [],
    account_periods,
    budget_periods,
    accounts_directory,
    regional_directors_display,
    board: boardSingle,
    week_budgets: buildWeekBudgets({ start, end, budget_periods, fy: fiscalYear }),
    prior_period_comparison: priorCmpSingle,
    name_availability: {
      has_names: resolvedNames > 0,
      resolved: resolvedNames,
      total: workerIds.length,
      reason: resolvedNames === workerIds.length && workerIds.length > 0
        ? "all_resolved_from_users_endpoint"
        : !usersReachable
          ? "users_table_empty_or_unreachable"
          : "some_workers_lack_user_id_or_canonical_name",
    },
  };
  Object.assign(bodySingle, pinHourlyOnly(bodySingle.board));
  if (mergeSalary) {
    const budQ: any = salaryBudRespShared;
    const actQ: any = await loadSalaryActuals(supa, [account], start, end);
    if (budQ.error) return { status: 500, body: safeErrorLabor("kpi_budgets_3100_2", budQ.error) };
    if (actQ.error) return { status: 500, body: safeErrorLabor("labor_salary_actuals", actQ.error) };
    const salaryOnlyIds = [...new Set(actQ.rows.map((r: any) => r.worker_id))]
      .filter((id: any) => id && !bodySingle.workers[id]);
    let mergedWorkerToEmail = workerToEmail;
    if (salaryOnlyIds.length > 0) {
      const extra: any = await resolveWorkerMeta(supa, salaryOnlyIds);
      bodySingle.workers = { ...bodySingle.workers, ...extra.workerMeta };
      mergedWorkerToEmail = buildWorkerToEmail(bodySingle.workers);
    }
    bodySingle = withSalaryMerge(bodySingle, {
      account, members: [account], start, end, today,
      buildBoard,
      buildWeekBudgets,
      salary3100_2: budQ.byAccount,
      salaryRows: actQ.rows,
      workerToEmail: mergedWorkerToEmail,
      fy: fiscalYear,
    } as any);
    const closedLaborBudgetMerged = (bodySingle.budget_periods || [])
      .filter((bp: any) => closedPeriodsSingle.includes(bp.period_no))
      .reduce((s: number, bp: any) => s + Number(bp.amount || 0), 0);
    attachBatrToBoard(bodySingle.board, revenueBasisSingle, {
      closedLaborBudget: closedLaborBudgetMerged,
      closedPeriods: closedPeriodsSingle,
      fy: fiscalYear,
    });
    const salaryBudgetByPeriodMerged = new Map();
    const salaryByAcct = budQ?.byAccount instanceof Map ? budQ.byAccount.get(account) : null;
    if (salaryByAcct) {
      for (const [pn, amt] of salaryByAcct) {
        salaryBudgetByPeriodMerged.set(Number(pn), Number(amt || 0));
      }
    }
    const lineTargetPctMerged = computeLineTargetPctByPeriod({
      budgetPeriods: bodySingle.budget_periods,
      overviewBudgets: overviewBudgetsSingle?.data || new Map(),
      members: [account],
      periods: rangePeriodsSingle,
      salaryBudgetByPeriod: salaryBudgetByPeriodMerged,
    });
    const mergedLineTargetPct = computeMergedLineTargetPctByPeriod({
      mergedBudgetPeriods: bodySingle.budget_periods,
      overviewBudgets: overviewBudgetsSingle?.data || new Map(),
      members: [account],
      periods: rangePeriodsSingle,
    });
    attachWeeklyBasisToBoard(bodySingle.board, weeklyBasisSingle, {
      lineTargetPctByPeriod: lineTargetPctMerged,
      mergedTargetPctByPeriod: mergedLineTargetPct,
      todayISO: today,
      contractualAccrualByPeriod: contractualAccrualSingle,
      verifiedPeriodTotals: verifiedPeriodTotalsSingle,
      salaryBudgetByPeriod: salaryBudgetByPeriodMerged,
      feeBudgetByPeriod: feeBudgetByPeriodSingle,
      fy: fiscalYear,
    } as any);
    recomputePanelBatrFromPerWeek(bodySingle.board);
    applyFinanceCloseSingle(bodySingle.board);
    recomputeVerdictFromPanel(bodySingle.board);
    const salaryOnly = [...new Set(actQ.rows.map((r: any) => r.worker_id))]
      .filter((id: any) => id && !bodySingle.workers[id]);
    if (salaryOnly.length > 0) {
      const extra: any = await resolveWorkerMeta(supa, salaryOnly);
      bodySingle.workers = { ...bodySingle.workers, ...extra.workerMeta };
    }
  }
  bodySingle.salary_available = salary_available;
  bodySingle.salary_included = includeSalary;
  bodySingle.landing_account = landing_account;
  bodySingle.preview_account = preview_account;
  bodySingle.source = "weekly";
  bodySingle.homestands = homestandsList;
  if (homestandBank) bodySingle.homestand_bank = homestandBank;
  if (homestandSplice) Object.assign(bodySingle, homestandSplice);
  bodySingle.is_future_range = is_future_range;
  if (_labSnapped && !homestandParam) {
    bodySingle.range_snap = {
      snapped: true,
      snapped_from: _labSnappedFrom,
      snapped_to: { start, end },
    };
  }
  bodySingle.todayISO = today;
  return { status: 200, body: bodySingle };
}

// ─── getPurchasing ─────────────────────────────────────────────────
//
// Port of v1 src/app/api/kpi/purchasing/route.js GET handler.

const PURCH_V6_PSEUDO_KEYS = new Set(["ALL", "EAST", "WEST"]);
const PURCH_D17_OUT_OF_SCOPE = new Set(["CORP"]);
const PURCH_ENVELOPE_ACCOUNTS = PURCHASING_ENVELOPE_EXCLUSIONS;
const PURCH_PROVISIONAL_WINDOW_DAYS = 16;
const PURCH_CATEGORY_PRIORITY = ["3200.1", "3200.2", "3400.1", "3400.2", "3400.5"];
const PURCH_BUCKETS = [
  { key: "food", gl_prefix: "3200", label: "Food" },
  { key: "packaging", gl_prefix: "3400", label: "Packaging & supplies" },
  { key: "vehicle", gl_prefix: "3500", label: "Vehicle" },
];

function bucketForGl(gl: any) {
  if (!gl) return null;
  const s = String(gl);
  if (s.startsWith("3200")) return "food";
  if (s.startsWith("3400")) return "packaging";
  if (s.startsWith("3500")) return "vehicle";
  return null;
}

function comparePriority(a: any, b: any) {
  const ai = PURCH_CATEGORY_PRIORITY.indexOf(a);
  const bi = PURCH_CATEGORY_PRIORITY.indexOf(b);
  if (ai >= 0 && bi >= 0) return ai - bi;
  if (ai >= 0) return -1;
  if (bi >= 0) return 1;
  const rank = (x: any) => {
    if (!x) return 9;
    const s = String(x);
    if (s.startsWith("32") || s.startsWith("34") || s.startsWith("35")) return 1;
    if (s.startsWith("13")) return 2;
    if (s.startsWith("5")) return 3;
    return 4;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return String(a).localeCompare(String(b));
}

function glBucketFor(accountNumber: any) {
  if (!accountNumber) return null;
  const s = String(accountNumber);
  if (s.startsWith("32") || s.startsWith("34") || s.startsWith("35")) return "pl_cogs";
  if (s.startsWith("13")) return "reimbursable";
  if (s.startsWith("5")) return "sga";
  return "other";
}

function stateOf({ spent, budget, elapsedFrac, hasBills, isPassThrough }: any) {
  if (isPassThrough) return "passthru";
  if (!(budget > 0)) return "nobud";
  if (!hasBills) return "none";
  if (!(elapsedFrac > 0)) return "none";
  const pace = spent / (budget * elapsedFrac);
  if (pace > 1.03) return "over";
  if (pace < 0.97) return "under";
  return "onpace";
}

export async function getPurchasing({
  supa, today, now, fiscalYear, caller, query, feeGoals,
}: any): Promise<{ status: number; body: any }> {
  const q: any = query || {};
  let account = (q.account || "").trim();
  const previewParam = (q.preview || "").trim();
  // Default start = FY-start from fiscalYear; default end = today.
  let start = (q.start || "").trim() || fiscalYear.startISO;
  let end = (q.end || "").trim() || today;
  const _purSnap: any = snapRange(start, end, today, fiscalYear);
  const _purSnapped = _purSnap.snapped;
  const _purSnappedFrom = _purSnap.snapped_from;
  start = _purSnap.start;
  end = _purSnap.end;
  const drill = (q.drill || "").trim().toLowerCase();
  const includeLines = drill === "lines";
  const includeTable = (q.table || "").trim() === "1";
  const pageSizeParam = parseInt(String(q._page_size || "0"), 10);

  if (!caller) return { status: 403, body: { error: "forbidden" } };
  const landing_account = landingAccount(caller);

  // Preview target validation.
  const previewIsValidTarget = previewParam && (
    isKnownAccount(previewParam) || PURCH_V6_PSEUDO_KEYS.has(previewParam)
  );
  const preview: any = resolvePreviewAccess({
    caller,
    canViewAccount,
    urlAccount: account,
    previewParam: previewIsValidTarget ? previewParam : "",
  });
  account = preview.account;
  const preview_account = preview.preview_account;

  if (!account) {
    return {
      status: 400,
      body: {
        error: "account_required",
        detail: "?account=<team_key> is required",
        landing_account,
        preview_account,
        todayISO: today,
      },
    };
  }
  if (PURCH_D17_OUT_OF_SCOPE.has(account)) {
    return { status: 400, body: { error: "account_out_of_scope", account } };
  }

  if (!canViewAccount(caller, account)) {
    return {
      status: 200,
      body: {
        locked: true,
        account,
        reason: "not_authorised",
        landing_account,
        preview_account,
        todayISO: today,
      },
    };
  }

  const membersResp: any = await fetchMembers(supa, account);
  if (membersResp.error) return { status: 500, body: safeErrorPurchasing("members", membersResp.error) };
  const members: any = membersResp.members;
  if (members.length === 0) {
    return { status: 400, body: { error: "no_members_in_selection", account } };
  }

  const isAggregate = PURCH_V6_PSEUDO_KEYS.has(account);

  // Fiscal-week overlap adoption (labor-style).
  const fiscalWeeks: any = weekStartsInRange(start, end, fiscalYear);
  const effStart = fiscalWeeks.length > 0 ? fiscalWeeks[0] : start;
  const effEnd = fiscalWeeks.length > 0
    ? (() => {
      const last = fiscalWeeks[fiscalWeeks.length - 1];
      const d = new Date(last + "T00:00:00.000Z");
      d.setUTCDate(d.getUTCDate() + 6);
      return d.toISOString().slice(0, 10);
    })()
    : end;

  const fyForRange = fiscalYear.year;

  const rangeSelectionEarly: any = inferRangeSelection(start, end, fiscalYear);
  const isSinglePeriodRange = rangeSelectionEarly?.kind === "period" && rangeSelectionEarly.value != null;
  const singlePeriodNo = isSinglePeriodRange ? Number(rangeSelectionEarly.value) : null;
  const rangeEndDate = new Date(end + "T23:59:59Z");
  const todayDateEarly = new Date(today + "T00:00:00Z");
  const isClosedSinglePeriod = isSinglePeriodRange && rangeEndDate < todayDateEarly;

  // Shared report-only pending promise (reused by loadCardCharges).
  const reportOnlyPromise = loadReportOnlyPending(supa, {
    members: members.filter((m: any) => m !== "CORP"),
    start: effStart, end: effEnd, IN_CHUNK,
  });

  const [
    weeklyResp, pendingResp, reportPendingResp, actualsResp, freshness,
    dirResp, priorHistoryResp, complianceResp, budgetsResp,
    vehicleR, equipR, repairR, reimbR, cardChR, vendorRollupR,
  ]: any = await Promise.all([
    paginateWeekly(supa, { members, start: effStart, end: effEnd, fy: fiscalYear, now } as any),
    loadPending(supa, { members, start: effStart, end: effEnd }),
    reportOnlyPromise,
    paginatePurchasingActuals(supa, { members, start: effStart, end: effEnd, pageSize: pageSizeParam, includeLines, now } as any),
    loadFreshness(supa, { now } as any),
    loadAccountsDirectory(supa),
    isClosedSinglePeriod
      ? loadPriorPeriodHistory(supa, { members, periodNo: singlePeriodNo, fy: fiscalYear } as any)
      : Promise.resolve({ data: null }),
    loadCompliance(supa, { members, start: effStart, end: effEnd, today }),
    loadPurchasingBudgets(supa, members, fyForRange),
    loadLedgerRows(supa, { members, start: effStart, end: effEnd, glLikePrefix: "3500%", cap: 25 }),
    loadLedgerRows(supa, { members, start: effStart, end: effEnd, glLineCode: "5002.5", cap: 25 }),
    loadLedgerRows(supa, { members, start: effStart, end: effEnd, glLineCode: "5002.1", cap: 25 }),
    loadLedgerRows(supa, { members, start: effStart, end: effEnd, glLikePrefix: "13%", cap: 25 }),
    loadCardCharges(supa, { members, start: effStart, end: effEnd, today, cap: 50, reportOnlyPromise } as any),
    loadVendorRollup(supa, { members, start: effStart, end: effEnd }),
  ]);
  if (weeklyResp.error) return { status: 500, body: safeErrorPurchasing("v_purchasing_by_site_week", weeklyResp.error) };
  if (pendingResp.error) return { status: 500, body: safeErrorPurchasing("pending", pendingResp.error) };
  if (reportPendingResp.error) return { status: 500, body: safeErrorPurchasing("rippling_report_only_pending_v1", reportPendingResp.error) };
  if (actualsResp.error) return { status: 500, body: safeErrorPurchasing("purchasing_actuals", actualsResp.error) };
  if (dirResp.error) return { status: 500, body: safeErrorPurchasing("accounts_directory", dirResp.error) };
  if (priorHistoryResp.error) return { status: 500, body: safeErrorPurchasing("prior_period_history", priorHistoryResp.error) };
  if (complianceResp.error) return { status: 500, body: safeErrorPurchasing("compliance", complianceResp.error) };
  if (budgetsResp.error) return { status: 500, body: safeErrorPurchasing("kpi_budgets", budgetsResp.error) };
  if (vehicleR.error) return { status: 500, body: safeErrorPurchasing("ledgers.vehicle", vehicleR.error) };
  if (equipR.error) return { status: 500, body: safeErrorPurchasing("ledgers.equipment", equipR.error) };
  if (repairR.error) return { status: 500, body: safeErrorPurchasing("ledgers.repair", repairR.error) };
  if (reimbR.error) return { status: 500, body: safeErrorPurchasing("ledgers.reimbursable", reimbR.error) };
  if (cardChR.error) return { status: 500, body: safeErrorPurchasing("card_charges", cardChR.error) };
  if (vendorRollupR.error) return { status: 500, body: safeErrorPurchasing("vendor_rollup", vendorRollupR.error) };
  const budgetsByLine: any = budgetsResp.data;
  const weekly: any = weeklyResp.data;
  const pending: any = mergePending(pendingResp.data, reportPendingResp.data);
  const actuals: any = actualsResp.data;

  {
    const apiThrough = freshness.cards_through;
    const reportOnlyUnavailable = pending.report_only.unavailable === true;
    const reportThrough = reportOnlyUnavailable ? null : pending.report_only.max_purchased_at;
    freshness.cards_through_effective =
      apiThrough && reportThrough
        ? (apiThrough > reportThrough ? apiThrough : reportThrough)
        : (apiThrough || reportThrough || null);
    freshness.report_only_unavailable = reportOnlyUnavailable;
    freshness.report_only_unavailable_reason = pending.report_only.unavailable_reason || null;
  }

  // budgetForRange / budgetForPeriod closures.
  function budgetForRange({ byLine, glLineCode, members, start, end }: any) {
    const weeks: any = weekStartsInRange(start, end, fiscalYear);
    if (weeks.length === 0) return 0;
    const perLine = byLine.get(glLineCode);
    if (!perLine) return 0;
    let total = 0;
    for (const w of weeks) {
      const p: any = periodOfLabor(w, fiscalYear);
      if (p == null) continue;
      for (const m of members) {
        if (PURCH_ENVELOPE_ACCOUNTS.has(m)) continue;
        const byAcct = perLine.get(m);
        if (!byAcct) continue;
        const amt = byAcct.get(p);
        if (amt == null) continue;
        total += amt / 4;
      }
    }
    return Math.round(total * 100) / 100;
  }
  function budgetForPeriod({ byLine, glLineCode, members, periodNo }: any) {
    const perLine = byLine.get(glLineCode);
    if (!perLine) return 0;
    let total = 0;
    for (const m of members) {
      if (PURCH_ENVELOPE_ACCOUNTS.has(m)) continue;
      const byAcct = perLine.get(m);
      if (!byAcct) continue;
      const amt = byAcct.get(periodNo);
      if (amt == null) continue;
      total += amt;
    }
    return Math.round(total * 100) / 100;
  }

  const glLineCodesInWeekly = new Set();
  for (const r of weekly) if (r.gl_line_code) glLineCodesInWeekly.add(canonicalSubLine(r.gl_line_code));
  const glLineCodesInBudget = new Set([...budgetsByLine.keys()]
    .map((gl: any) => canonicalSubLine(gl))
    .filter((gl: any) => {
      const b = budgetForRange({ byLine: budgetsByLine, glLineCode: gl, members, start, end });
      return b > 0;
    }));
  const allGl = new Set([...glLineCodesInWeekly, ...glLineCodesInBudget] as any);
  const orderedGl = [...allGl].sort(comparePriority);

  function spentForGl(gl: any) {
    let s = 0;
    for (const r of weekly) if (isDescendantOfLine(r.gl_line_code, gl)) s += Number(r.amount || 0);
    return Math.round(s * 100) / 100;
  }
  function billsOnlySpentForGl(gl: any) {
    let s = 0;
    for (const r of actuals) {
      if (!isDescendantOfLine(r.gl_line_code, gl)) continue;
      if (r.source === "rippling_spend") continue;
      s += Number(r.amount || 0);
    }
    return Math.round(s * 100) / 100;
  }
  function codedCardSpentForGl(gl: any) {
    let s = 0;
    for (const r of actuals) {
      if (!isDescendantOfLine(r.gl_line_code, gl)) continue;
      if (r.source !== "rippling_spend") continue;
      s += Number(r.amount || 0);
    }
    return Math.round(s * 100) / 100;
  }

  const rangeSelection: any = inferRangeSelection(start, end, fiscalYear);
  const periodNo = rangeSelection?.kind === "period" ? rangeSelection.value : null;
  const weeks: any = weekStartsInRange(start, end, fiscalYear);
  const weeksInRange = weeks.length;
  const todayDate = new Date(today);
  const endDate = new Date(end);
  const startDate = new Date(start);
  const closedWeeksInRange = weeks.filter((w: any) => {
    const wEnd = new Date(new Date(w).getTime() + 6 * 86400000);
    return wEnd < todayDate;
  }).length;
  let elapsedFrac = 1.0;
  if (endDate >= todayDate && weeksInRange > 0) {
    const dow = todayDate.getUTCDay();
    const daysToMon = (dow + 6) % 7;
    const runFrac = Math.min(1, (daysToMon + 1) / 7);
    elapsedFrac = Math.min(1.0, (closedWeeksInRange + runFrac) / weeksInRange);
  }

  const isPassThroughAccount = !isAggregate && PASS_THROUGH_ACCOUNTS.has(account);

  const categories = orderedGl.map((gl: any) => {
    const budget = budgetForRange({ byLine: budgetsByLine, glLineCode: gl, members, start, end });
    const spent = spentForGl(gl);
    if (isPassThroughAccount) {
      return {
        gl_line_code: gl,
        bucket: glBucketFor(gl),
        budget,
        spent,
        variance: null,
        pace_pct: null,
        final: false,
      };
    }
    const variance = Math.round((spent - budget) * 100) / 100;
    let pace_pct: any = null;
    let final = false;
    if (endDate < todayDate) {
      final = true;
      pace_pct = budget > 0 ? Math.round((spent / budget) * 100 * 100) / 100 : null;
    } else if (elapsedFrac > 0 && budget > 0) {
      pace_pct = Math.round(((spent / (budget * elapsedFrac))) * 100 * 100) / 100;
    }
    return {
      gl_line_code: gl,
      bucket: glBucketFor(gl),
      budget,
      spent,
      variance,
      pace_pct,
      final,
    };
  });

  const buckets = PURCH_BUCKETS.map(({ key, gl_prefix, label }) => {
    let budget = 0;
    let spent = 0;
    let cardsCoded = 0;
    const line_codes: any[] = [];
    for (const gl of orderedGl) {
      if (bucketForGl(gl) !== key) continue;
      line_codes.push(gl);
      budget += budgetForRange({ byLine: budgetsByLine, glLineCode: gl, members, start, end });
      spent += billsOnlySpentForGl(gl);
      cardsCoded += codedCardSpentForGl(gl);
    }
    const budgetR = Math.round(budget * 100) / 100;
    const spentR = Math.round(spent * 100) / 100;
    const cardsCodedR = Math.round(cardsCoded * 100) / 100;
    if (isPassThroughAccount) {
      return {
        bucket: key,
        label,
        gl_prefix,
        budget: budgetR,
        spent: spentR,
        cards_coded: cardsCodedR,
        variance: null,
        pace_pct: null,
        state: stateOf({ isPassThrough: true }),
        line_codes,
      };
    }
    const varianceR = Math.round((spentR - budgetR) * 100) / 100;
    let pace_pct: any = null;
    if (endDate < todayDate) {
      pace_pct = budgetR > 0 ? Math.round((spentR / budgetR) * 100 * 100) / 100 : null;
    } else if (elapsedFrac > 0 && budgetR > 0) {
      pace_pct = Math.round(((spentR / (budgetR * elapsedFrac))) * 100 * 100) / 100;
    }
    const state = stateOf({
      spent: spentR,
      budget: budgetR,
      elapsedFrac,
      hasBills: spentR > 0,
    });
    return {
      bucket: key,
      label,
      gl_prefix,
      budget: budgetR,
      spent: spentR,
      cards_coded: cardsCodedR,
      variance: varianceR,
      pace_pct,
      state,
      line_codes,
    };
  });

  const currentP = currentPeriodNo(today, fiscalYear) || 1;
  const periods: any[] = [];
  let fyWeekly: any;
  {
    const fyStartISO = fiscalYear.startISO;
    if (start === fyStartISO && end === today) {
      fyWeekly = weekly;
    } else {
      const fyWeeklyResp: any = await paginateWeekly(supa, { members, start: fyStartISO, end: today, fy: fiscalYear, now } as any);
      if (fyWeeklyResp.error) {
        return { status: 500, body: safeErrorPurchasing("periods_weekly", fyWeeklyResp.error) };
      }
      fyWeekly = fyWeeklyResp.data;
    }
    const spentByPeriod = new Map<any, any>();
    const spentByPeriodByBucket = new Map<any, any>();
    for (const r of fyWeekly) {
      const p: any = periodOfLabor(r.week_start, fiscalYear);
      if (p == null) continue;
      spentByPeriod.set(p, (spentByPeriod.get(p) || 0) + Number(r.amount || 0));
      const bk: any = bucketForGl(r.gl_line_code);
      if (!bk) continue;
      if (!spentByPeriodByBucket.has(p)) {
        spentByPeriodByBucket.set(p, { food: 0, packaging: 0, vehicle: 0 });
      }
      spentByPeriodByBucket.get(p)[bk] += Number(r.amount || 0);
    }
    for (let p = 1; p <= currentP; p += 1) {
      const pStart = periodStartISO(p, fiscalYear);
      const pEnd = periodEndISO(p, fiscalYear);
      let budgetP = 0;
      const bucketBudgetP: any = { food: 0, packaging: 0, vehicle: 0 };
      for (const gl of budgetsByLine.keys()) {
        const glB = budgetForPeriod({ byLine: budgetsByLine, glLineCode: gl, members, periodNo: p });
        budgetP += glB;
        const bk: any = bucketForGl(gl);
        if (bk) bucketBudgetP[bk] += glB;
      }
      const spentP = Math.round((spentByPeriod.get(p) || 0) * 100) / 100;
      const bucketSpentP: any = spentByPeriodByBucket.get(p) || { food: 0, packaging: 0, vehicle: 0 };
      const closed = new Date(pEnd) < todayDate;
      periods.push({
        period_no: p,
        start: pStart,
        end: pEnd,
        spent: spentP,
        budget: Math.round(budgetP * 100) / 100,
        closed,
        by_bucket: {
          food: { spent: Math.round(bucketSpentP.food * 100) / 100, budget: Math.round(bucketBudgetP.food * 100) / 100 },
          packaging: { spent: Math.round(bucketSpentP.packaging * 100) / 100, budget: Math.round(bucketBudgetP.packaging * 100) / 100 },
          vehicle: { spent: Math.round(bucketSpentP.vehicle * 100) / 100, budget: Math.round(bucketBudgetP.vehicle * 100) / 100 },
        },
      });
    }
  }

  function sumSpentByBucket(bucket: any) {
    let s = 0;
    for (const r of weekly) if (r.gl_bucket === bucket) s += Number(r.amount || 0);
    return Math.round(s * 100) / 100;
  }
  function sumBudgetByBucket(bucket: any) {
    let s = 0;
    for (const gl of budgetsByLine.keys()) {
      if (glBucketFor(gl) !== bucket) continue;
      s += budgetForRange({ byLine: budgetsByLine, glLineCode: gl, members, start, end });
    }
    return Math.round(s * 100) / 100;
  }
  const pl_cogs_spent = sumSpentByBucket("pl_cogs");
  const pl_cogs_budget = sumBudgetByBucket("pl_cogs");
  const reimb_spent = sumSpentByBucket("reimbursable");
  const sga_spent = sumSpentByBucket("sga");
  let card_spent = 0;
  let card_unattributed = 0;
  let card_uncoded = 0;
  for (const r of actuals) {
    if (r.source !== "rippling_spend") continue;
    card_spent += Number(r.amount || 0);
    if (!r.account_key) card_unattributed++;
    if (!r.gl_line_code) card_uncoded++;
  }

  const totals = {
    pl_cogs: {
      budget: pl_cogs_budget,
      spent: pl_cogs_spent,
      variance: Math.round((pl_cogs_spent - pl_cogs_budget) * 100) / 100,
    },
    reimbursable: {
      spent: reimb_spent,
      billed_to_client: reimb_spent,
    },
    sga: {
      spent: sga_spent,
    },
    card: {
      spent: Math.round(card_spent * 100) / 100,
      unattributed: card_unattributed,
      uncoded: card_uncoded,
    },
  };

  const provisionalCutoff = new Date(endDate.getTime() + PURCH_PROVISIONAL_WINDOW_DAYS * 86400000);
  const provisional = provisionalCutoff > todayDate;

  const debugRequested = (q.debug || "").trim() === "1";
  const sentinelResp: any = debugRequested
    ? await computeSentinel(supa, fiscalYear)
    : { data: null };

  // R&M vendor-in-rm flag.
  const RM_VEHICLE_VENDOR_PATTERNS = [
    "MEINEKE", "FIRESTONE", "MIDAS", "GOODYEAR", "JIFFY LUBE",
    "ENTERPRISE RENT", "HERTZ", "AVIS", "DISCOUNT TIRE",
    "AUTOZONE", "ADVANCE AUTO", "O'REILLY", "PEP BOYS", "VALVOLINE",
    "BIG O TIRES", "LES SCHWAB", "AAMCO", "MAACO", "CHRISTIAN BROTHERS",
    "MAVIS TIRE", "GRUBBS", "BROWN AUTOMOTIVE", "PENSKE", "RYDER",
    "U-HAUL", "UHAUL", "NAPA AUTO", "CARQUEST",
  ];
  for (const row of (repairR.data?.rows || [])) {
    const v = String(row.vendor || "").toUpperCase();
    const match = RM_VEHICLE_VENDOR_PATTERNS.find(pat => v.startsWith(pat));
    if (match) {
      row.flag = { kind: "vehicle-in-rm", reason: "vehicle service in 5002.1" };
    }
  }

  // Management-fee board (pass-through only).
  let mgmt_fee: any = null;
  if (isPassThroughAccount) {
    let goalFytdSpent = 0;
    const trendByPeriod = new Map<any, any>();
    for (const r of fyWeekly) {
      if (r.gl_bucket !== "reimbursable") continue;
      goalFytdSpent += Number(r.amount || 0);
      const p: any = periodOfLabor(r.week_start, fiscalYear);
      if (p == null) continue;
      trendByPeriod.set(p, (trendByPeriod.get(p) || 0) + Number(r.amount || 0));
    }
    const periods_trend: any[] = [];
    for (let p = 1; p <= currentP; p += 1) {
      periods_trend.push({
        period_no: p,
        start: periodStartISO(p, fiscalYear),
        end: periodEndISO(p, fiscalYear),
        spent: Math.round((trendByPeriod.get(p) || 0) * 100) / 100,
      });
    }
    const fmSpent = spentForGl("3200.2");
    const fmBudget = budgetForRange({ byLine: budgetsByLine, glLineCode: "3200.2", members, start, end });
    const fun_money = {
      gl_line_code: "3200.2",
      label: "Fun Money",
      sub: "Resale food · 3200.2",
      budget: Math.round(fmBudget * 100) / 100,
      spent: Math.round(fmSpent * 100) / 100,
      variance: Math.round((fmSpent - fmBudget) * 100) / 100,
    };
    const reimb_categories_raw: any[] = [];
    for (const gl of orderedGl) {
      if (!String(gl).startsWith("13")) continue;
      const spent = spentForGl(gl);
      if (spent <= 0.005) continue;
      reimb_categories_raw.push({ gl_line_code: gl, spent: Math.round(spent * 100) / 100 });
    }
    const glCodesToName = reimb_categories_raw.map(r => r.gl_line_code);
    let namesByCode = new Map();
    if (glCodesToName.length > 0) {
      // Train 2c: paged via pagedSelect. billcom_ref_accounts.account_number
      // is the PK so the sort is unique.
      const nq: any = await pagedSelect((from: number, to: number) => supa
        .from("billcom_ref_accounts")
        .select("account_number, name")
        .in("account_number", glCodesToName)
        .order("account_number")
        .range(from, to));
      if (nq.error) return { status: 500, body: safeErrorPurchasing("billcom_ref_accounts", nq.error) };
      for (const r of nq.data || []) namesByCode.set(String(r.account_number), r.name || null);
    }
    const reimb_categories = reimb_categories_raw.map(r => ({
      gl_line_code: r.gl_line_code,
      name: namesByCode.get(r.gl_line_code) || null,
      spent: r.spent,
    }));
    const goalRow: any = (feeGoals && feeGoals[account]) ? feeGoals[account] : null;
    let crossed_period_no: any = null;
    if (goalRow && goalRow.annual > 0) {
      let cum = 0;
      for (const t of periods_trend) {
        cum += Number(t.spent || 0);
        if (cum >= goalRow.annual) { crossed_period_no = t.period_no; break; }
      }
    }
    mgmt_fee = {
      goal_fytd_spent: Math.round(goalFytdSpent * 100) / 100,
      periods_trend,
      fun_money,
      client_label: goalRow?.clientLabel || account,
      tax_caveat_state: goalRow?.taxCaveatState || null,
      reimb_categories,
      crossed_period_no,
    };
  }

  let weekly_by_source: any = null;
  if (includeTable) {
    const fyStartISO = fiscalYear.startISO;
    function weekStartFromTxnDate(txnDate: any) {
      const t = new Date(txnDate + "T00:00:00Z").getTime();
      const fs = new Date(fyStartISO + "T00:00:00Z").getTime();
      if (!Number.isFinite(t) || t < fs) return null;
      const wks = Math.floor((t - fs) / (7 * 86400000));
      return new Date(fs + wks * 7 * 86400000).toISOString().slice(0, 10);
    }
    function columnFor(r: any) {
      if (r.gl_line_code === "5002.5") return "equipment";
      if (r.gl_line_code === "5002.1") return "repair";
      return bucketForGl(r.gl_line_code);
    }
    const acc = new Map<any, any>();
    for (const r of actuals) {
      const col: any = columnFor(r);
      if (!col) continue;
      const src = r.source === "rippling_spend" ? "rippling_spend" : "billcom";
      const ws = weekStartFromTxnDate(r.txn_date);
      if (!ws) continue;
      if (!acc.has(ws)) acc.set(ws, {});
      const wk = acc.get(ws);
      if (!wk[col]) wk[col] = { billcom: 0, rippling_spend: 0 };
      wk[col][src] += Math.round(Number(r.amount || 0) * 100);
    }
    const rows: any[] = [];
    for (const [ws, cols] of acc as any) {
      for (const [col, sources] of Object.entries(cols) as any) {
        for (const [src, cents] of Object.entries(sources as any) as any) {
          if (cents === 0) continue;
          rows.push({
            week_start: ws,
            column: col,
            source: src,
            amount: Math.round(Number(cents)) / 100,
          });
        }
      }
    }
    weekly_by_source = rows;
  }

  const is_future_range = startDate > todayDate;

  const payload: any = {
    ok: true,
    range: { start, end },
    is_future_range,
    landing_account,
    preview_account,
    fiscal: {
      fiscal_year: fyForRange,
      period_no: periodNo,
      elapsed_frac: Math.round(elapsedFrac * 10000) / 10000,
      weeks_in_range: weeksInRange,
      closed_weeks_in_range: closedWeeksInRange,
    },
    budget: {
      by_gl_line_code: orderedGl.map((gl: any) => ({
        gl_line_code: gl,
        amount: budgetForRange({ byLine: budgetsByLine, glLineCode: gl, members, start, end }),
      })),
    },
    weekly,
    pending,
    buckets,
    periods,
    period_history: priorHistoryResp.data,
    categories,
    totals,
    provisional,
    freshness,
    accounts_directory: dirResp.data,
    sentinel: sentinelResp.error ? null : sentinelResp.data,
    ledgers: {
      vehicle: vehicleR.data,
      equipment: equipR.data,
      repair: repairR.data,
      reimbursable: reimbR.data,
    },
    card_charges: cardChR.data,
    vendor_rollup: vendorRollupR.data,
    mgmt_fee,
    weekly_by_source,
    compliance: complianceResp.data,
  };
  if (includeLines) {
    const billcomVendorIds = [
      ...new Set(actuals.filter((r: any) => r.source === "billcom" && r.vendor_or_merchant).map((r: any) => r.vendor_or_merchant)),
    ];
    const vendorNameMap = new Map();
    if (billcomVendorIds.length > 0) {
      for (const idChunk of chunk(billcomVendorIds, IN_CHUNK)) {
        const vr: any = await supa.from("billcom_ref_vendors").select("id, name").in("id", idChunk as any);
        if (vr.error) return { status: 500, body: safeErrorPurchasing("billcom_ref_vendors", vr.error) };
        for (const v of vr.data || []) vendorNameMap.set(v.id, v.name || null);
      }
    }
    payload.actuals = actuals.map((r: any) => {
      let vendor: any = null;
      if (r.source === "billcom") {
        if (r.vendor_or_merchant && vendorNameMap.has(r.vendor_or_merchant)) {
          vendor = vendorNameMap.get(r.vendor_or_merchant);
        }
      } else {
        vendor = r.vendor_or_merchant || null;
      }
      const { vendor_or_merchant: _drop, ...rest } = r;
      return { ...rest, vendor };
    });
  }

  if (_purSnapped) {
    payload.range_snap = {
      snapped: true,
      snapped_from: _purSnappedFrom,
      snapped_to: { start, end },
    };
  }

  payload.todayISO = today;
  return { status: 200, body: payload };
}
