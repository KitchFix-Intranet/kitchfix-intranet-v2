// The calendar's one loader. All DB reads live here. Pure functions
// live next to this file; load.ts is where the database is.
//
// Round trips per page load (ten in all):
//   1. rpc sc_site_today
//   2. fiscal_periods for the fiscal year
//   3. accounts row for this site
//   4. sc_services for this site - every row the site has ever had,
//      not only active ones (a service switched off still has rows
//      in the past and needs its unit)
//   5. sc_qbo_account_map for this site
//   6. sc_qbo_service_map for this site (export-excluded service ids)
//   7. sc_daily_revenue over the FY, paged with .range() and a count
//      assertion
//   8. sc_day_metadata over the FY
//   9. sc_week_finalize over the FY, status <> 'reverted'
//  10. sc_is_period_closed_fy via rpc, one call per period, in parallel
//  11. sc_phase_calendar for this site
//
// Independent reads go together through Promise.all so the cold load
// is bound by the slowest of the queries, not their sum. The first
// page of sc_daily_revenue carries the row count; any remaining pages
// are fetched together once that count is in hand.
//
// resolveFinalizeReviewSpan is called through makeInScopeAdapter so
// its two reads hit the already-loaded rows (zero extra network).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CalendarView,
  PeriodView,
  WeekView,
  DayView,
  DailyRevenueLite,
  ServiceLite,
  DayMetadataLite,
  FinalizeLite,
  AccountLite,
  QboAccountMapLite,
  PhaseRow,
  YearPeriodCard,
  YearSquare,
  ViewerLite,
  SiteInfo,
  HomeGameMark,
} from "./types";
import { resolveDayState } from "./dayState";
import { resolveWeekState } from "./weekState";
import { addDaysIso, dowOf, makePeriodWindow, periodHoldingDate } from "./periodWindow";
import { makeInScopeAdapter } from "./inScopeAdapter";
import { resolveFinalizeReviewSpan } from "@/lib/sc/scWeekFinalize";
import { sumBillablePretaxCents } from "@/lib/sc/billing/billableTotal";

const PAGE_SIZE = 1000;

export interface LoadCalendarInput {
  sb: SupabaseClient;
  viewer: ViewerLite;
  site: SiteInfo;
  fiscalYear: number;
  // When null, the loader picks the period that holds the site's own today.
  periodNo: number | null;
}

export async function loadCalendar(input: LoadCalendarInput): Promise<CalendarView> {
  const { sb, viewer, site, fiscalYear } = input;
  const accountKey = site.accountKey;

  // ── First wave: every read that does not depend on another read.
  // The thirteen period-closed rpc calls go in the same wave: they only
  // depend on the account key + fiscal year, both known up front.
  const closedPeriodRpcs = Array.from({ length: 13 }, (_, i) =>
    sb.rpc("sc_is_period_closed_fy", {
      p_account_key: accountKey,
      p_fiscal_year: fiscalYear,
      p_period_no: i + 1,
    }),
  );

  const [
    siteTodayQ,
    periodsQ,
    servicesQ,
    accMapQ,
    svcMapQ,
    metaQ,
    finQ,
    phaseQ,
    firstPageQ,
    ...closedResults
  ] = await Promise.all([
    sb.rpc("sc_site_today", { p_account_key: accountKey }),
    sb.from("fiscal_periods")
      .select("fiscal_year, period_no, start_date, end_date")
      .eq("fiscal_year", fiscalYear)
      .order("period_no"),
    sb.from("sc_services")
      .select("id, service_name, unit, is_flat_fee, is_non_revenue, active, active_until")
      .eq("account_key", accountKey),
    sb.from("sc_qbo_account_map")
      .select("account_key, cadence, active")
      .eq("account_key", accountKey)
      .maybeSingle(),
    sb.from("sc_qbo_service_map")
      .select("service_id, export_excluded")
      .eq("account_key", accountKey)
      .eq("export_excluded", true),
    // The FY date range is known up front from the fiscal_year argument;
    // narrow via account_key only and bound by a lenient date filter so
    // the single-page read holds the whole year.
    sb.from("sc_day_metadata")
      .select("service_date, review_status, event_label, game_type, game_time, week_label")
      .eq("account_key", accountKey),
    sb.from("sc_week_finalize")
      .select("id, week_start, status, finalized_at, push_attempts, push_done_at, push_gave_up_at")
      .eq("account_key", accountKey)
      .neq("status", "reverted"),
    sb.from("sc_phase_calendar")
      .select("phase, start_date, end_date")
      .eq("account_key", accountKey),
    // First page of sc_daily_revenue carries { count: 'exact' } so the
    // paging assertion can run as soon as this page returns.
    sb.from("sc_daily_revenue")
      .select(
        "service_date, service_id, is_flat_fee, is_non_revenue, actual_count, actual_price_at_date, price_at_date, projected_count, has_actuals, has_projection, actual_revenue",
        { count: "exact" },
      )
      .eq("account_key", accountKey)
      .order("service_date", { ascending: true })
      .order("service_id", { ascending: true })
      .range(0, PAGE_SIZE - 1),
    ...closedPeriodRpcs,
  ]);

  if (siteTodayQ.error) throw new Error(`sc_site_today: ${siteTodayQ.error.message}`);
  const siteToday = String(siteTodayQ.data);

  if (periodsQ.error) throw new Error(`fiscal_periods: ${periodsQ.error.message}`);
  const periodRows = (periodsQ.data ?? []) as { fiscal_year: number; period_no: number; start_date: string; end_date: string }[];
  if (periodRows.length === 0) {
    return emptyYearView(viewer, site, siteToday, fiscalYear);
  }
  if (periodRows.length !== 13) {
    throw new Error(`fiscal_periods: expected 13 rows for FY${fiscalYear}, got ${periodRows.length}`);
  }
  const fyStart = periodRows[0].start_date;
  const fyEnd = periodRows[12].end_date;

  let activePeriod = input.periodNo;
  if (activePeriod === null) {
    const hit = periodHoldingDate(
      periodRows.map((r) => ({ fiscalYear: r.fiscal_year, periodNo: r.period_no, startIso: r.start_date, endIso: r.end_date })),
      siteToday,
    );
    activePeriod = hit ? hit.periodNo : 1;
  }
  if (activePeriod < 1 || activePeriod > 13) activePeriod = 1;

  if (servicesQ.error) throw new Error(`sc_services: ${servicesQ.error.message}`);
  const services: ServiceLite[] = (servicesQ.data ?? []).map((r) => ({
    service_id: String((r as { id: string }).id),
    service_name: String((r as { service_name: string }).service_name),
    unit: ((r as { unit: string }).unit || "meals") as ServiceLite["unit"],
    is_flat_fee: !!(r as { is_flat_fee: boolean }).is_flat_fee,
    is_non_revenue: !!(r as { is_non_revenue: boolean | null }).is_non_revenue,
    active: !!(r as { active: boolean }).active,
    active_until: ((r as { active_until: string | null }).active_until) ?? null,
  }));
  const serviceById = new Map<string, ServiceLite>(services.map((s) => [s.service_id, s]));

  if (accMapQ.error) throw new Error(`sc_qbo_account_map: ${accMapQ.error.message}`);
  const qboMap: QboAccountMapLite | null = (accMapQ.data as QboAccountMapLite | null) ?? null;

  if (svcMapQ.error) throw new Error(`sc_qbo_service_map: ${svcMapQ.error.message}`);
  const excludedIds = new Set<string>(
    (svcMapQ.data ?? []).map((r) => String((r as { service_id: string }).service_id)),
  );

  if (metaQ.error) throw new Error(`sc_day_metadata: ${metaQ.error.message}`);
  const allMetaRows = (metaQ.data ?? []) as DayMetadataLite[];
  const metaRows = allMetaRows.filter((m) => m.service_date >= fyStart && m.service_date <= fyEnd);
  if (metaRows.length >= PAGE_SIZE) {
    throw new Error(`sc_day_metadata hit the ${PAGE_SIZE}-row cap for ${accountKey} FY${fiscalYear}; page it`);
  }
  const metaByDate = new Map<string, DayMetadataLite>(metaRows.map((m) => [m.service_date, m]));

  if (finQ.error) throw new Error(`sc_week_finalize: ${finQ.error.message}`);
  const allFinRows = (finQ.data ?? []) as FinalizeLite[];
  const finRows = allFinRows.filter((r) => r.week_start >= addDaysIso(fyStart, -7) && r.week_start <= fyEnd);
  if (finRows.length >= PAGE_SIZE) {
    throw new Error(`sc_week_finalize hit the ${PAGE_SIZE}-row cap for ${accountKey} FY${fiscalYear}; page it`);
  }

  if (phaseQ.error) throw new Error(`sc_phase_calendar: ${phaseQ.error.message}`);
  const phases: PhaseRow[] = (phaseQ.data ?? []).map((r) => ({
    phase: String((r as { phase: string }).phase),
    startIso: String((r as { start_date: string }).start_date),
    endIso: String((r as { end_date: string }).end_date),
  }));

  // Period-closed fan-out.
  const closedByPeriod = new Map<number, boolean>();
  for (let i = 0; i < closedResults.length; i++) {
    const r = closedResults[i];
    if (r.error) throw new Error(`sc_is_period_closed_fy p${i + 1}: ${r.error.message}`);
    closedByPeriod.set(i + 1, !!r.data);
  }

  // sc_daily_revenue paged. First page is already in hand; any
  // remaining pages go out together.
  if (firstPageQ.error) throw new Error(`sc_daily_revenue (page 0): ${firstPageQ.error.message}`);
  const total = firstPageQ.count ?? 0;
  const revenueBuffer: DailyRevenueLite[] = ((firstPageQ.data ?? []) as DailyRevenueLite[]).slice();
  if (revenueBuffer.length < total) {
    const laterPages = [];
    for (let start = PAGE_SIZE; start < total; start += PAGE_SIZE) {
      const end = Math.min(start + PAGE_SIZE - 1, total - 1);
      laterPages.push(
        sb.from("sc_daily_revenue")
          .select(
            "service_date, service_id, is_flat_fee, is_non_revenue, actual_count, actual_price_at_date, price_at_date, projected_count, has_actuals, has_projection, actual_revenue",
          )
          .eq("account_key", accountKey)
          .order("service_date", { ascending: true })
          .order("service_id", { ascending: true })
          .range(start, end),
      );
    }
    const results = await Promise.all(laterPages);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.error) throw new Error(`sc_daily_revenue (page ${(i + 1) * PAGE_SIZE}): ${r.error.message}`);
      for (const row of (r.data ?? []) as DailyRevenueLite[]) revenueBuffer.push(row);
    }
  }
  if (revenueBuffer.length !== total) {
    throw new Error(`sc_daily_revenue paging: expected ${total} rows, got ${revenueBuffer.length} for ${accountKey}`);
  }
  // Scope to this FY so no stray rows from the untyped filter can leak in.
  const revenue = revenueBuffer.filter((r) => r.service_date >= fyStart && r.service_date <= fyEnd);

  // Resolve the span of every finalize row through the in-memory adapter.
  // For biweekly OPEN weeks (no finalize row), the SAME helper gives
  // the unit so the day and week rules know when the unit ends.
  const adapter = makeInScopeAdapter({
    accountKey,
    cadence: qboMap?.cadence ?? null,
    weekLabelByDate: new Map(metaRows.map((m) => [m.service_date, m.week_label ?? null])),
  });

  const finSpans = await Promise.all(
    finRows.map(async (row) => {
      const span = await resolveFinalizeReviewSpan(accountKey, row.week_start, adapter);
      return { row, dates: new Set(span.dates), spanStart: span.spanStart, spanLength: span.dates.length };
    }),
  );

  // iso -> { row, span }
  const finByDate = new Map<string, { row: FinalizeLite; spanStart: string; spanLength: number }>();
  for (const s of finSpans) {
    for (const iso of s.dates) {
      finByDate.set(iso, { row: s.row, spanStart: s.spanStart, spanLength: s.spanLength });
    }
  }

  const revenueByDate = new Map<string, DailyRevenueLite[]>();
  for (const r of revenue) {
    const arr = revenueByDate.get(r.service_date);
    if (arr) arr.push(r); else revenueByDate.set(r.service_date, [r]);
  }

  // For each period I will draw (the active one on-stage, every one of
  // the 13 year cards), resolve each week's unit through the adapter.
  // Weekly sites always get a 7-day unit; biweekly sites answer with
  // the real pair unit even for open weeks.
  const activePeriodRow = periodRows.find((p) => p.period_no === activePeriod)!;
  const activeWindow = makePeriodWindow(fiscalYear, activePeriodRow.period_no, activePeriodRow.start_date, activePeriodRow.end_date);

  const activeUnits = await resolveWeeklyUnits(accountKey, qboMap?.cadence ?? null, activeWindow.weeks.map((w) => w[0]), adapter);

  const period = buildPeriodView({
    fiscalYear,
    periodNo: activePeriodRow.period_no,
    window: activeWindow,
    siteToday,
    cadence: qboMap?.cadence === "biweekly" ? "biweekly" : "weekly",
    revenueByDate,
    serviceById,
    metaByDate,
    finByDate,
    phases,
    isPeriodClosed: closedByPeriod.get(activePeriodRow.period_no) ?? false,
    excludedServiceIds: excludedIds,
    isBilled: qboMap !== null,
    isCorpViewer: viewer.is_corp && !viewer.is_regional_director,
    unitEndsByWeekStart: activeUnits,
  });

  // Year section: 13 cards. Same unit-resolution pass across the whole FY.
  const allWeekStarts: string[] = [];
  for (const p of periodRows) {
    const w = makePeriodWindow(fiscalYear, p.period_no, p.start_date, p.end_date);
    for (const wk of w.weeks) allWeekStarts.push(wk[0]);
  }
  const allUnits = await resolveWeeklyUnits(accountKey, qboMap?.cadence ?? null, allWeekStarts, adapter);

  const yearCards: YearPeriodCard[] = [];
  let yearEntered = 0;
  let yearMeals = 0;
  for (const p of periodRows) {
    const pw = makePeriodWindow(fiscalYear, p.period_no, p.start_date, p.end_date);
    const pClosed = closedByPeriod.get(p.period_no) ?? false;
    const squares: YearSquare[] = [];
    let cardMeals = 0;
    let needsCount = 0;
    let anyEntered = 0;
    for (const iso of pw.dates) {
      const weekStart = mondayFrom(iso);
      const unitEndIso = allUnits.get(weekStart) ?? addDaysIso(weekStart, 6);
      const sq = squareFor({
        iso, siteToday,
        revenue: revenueByDate.get(iso) ?? [],
        serviceById,
        meta: metaByDate.get(iso) ?? null,
        finOver: finByDate.get(iso) ?? null,
        isPeriodClosed: pClosed,
        unitEndIso,
      });
      squares.push(sq);
      // "Days entered" counts a day with any line above 0, whether it
      // counted in meals or not. A not-served day does not count.
      // (Chat-Claude ruling 2026-11-16 train 1b §6.)
      if (sq.hasAnyEnteredValue) anyEntered += 1;
      // Meals in the card total, however, still count only meal-unit
      // lines, so the period cards continue to agree with the year
      // total.
      if (sq.meals > 0) cardMeals += sq.meals;
      if (sq.state === "needs_actuals") needsCount += 1;
    }
    yearEntered += anyEntered;
    yearMeals += cardMeals;
    yearCards.push({
      periodNo: p.period_no,
      startIso: p.start_date,
      endIso: p.end_date,
      squares,
      meals: cardMeals,
      needsActualsCount: needsCount,
      isCurrent: p.period_no === activePeriod,
      isClosed: pClosed,
    });
  }

  const failedPushWeekStart = (viewer.is_corp && !viewer.is_regional_director)
    ? findFailedPush(period, finSpans)
    : null;

  return {
    viewer,
    site,
    today: siteToday,
    period,
    year: { fiscalYear, cards: yearCards, totals: { entered: yearEntered, meals: yearMeals } },
    failedPushWeekStart,
  };
}

// ─────────────────────────────────────────────────────────────────

// For every weekStart passed in, resolve the unit end through the
// engine helper (through the adapter, so no extra network). Returns
// a map weekStart -> last day of the unit (ISO).
//
// Weekly site: unit is always the own week (weekStart + 6).
//
// Biweekly site: the helper's weekIndex tells us where this week sits
// in a pair:
//   - weekIndex 1 or 3 (first week of a pair): the unit ENDS the
//     following Sunday, 14 days later (weekStart + 13).
//   - weekIndex 2 or 4 (second week of a pair): the unit STARTED the
//     Monday before, so the unit ends on own Sunday (weekStart + 6).
//   - weekIndex null (biweekly site but no label on the Monday): the
//     own-week default. Caller carries a note; treat as a 7-day unit.
async function resolveWeeklyUnits(
  accountKey: string,
  cadence: QboAccountMapLite["cadence"],
  weekStarts: readonly string[],
  adapter: SupabaseClient,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (cadence !== "biweekly") {
    for (const ws of weekStarts) out.set(ws, addDaysIso(ws, 6));
    return out;
  }
  const results = await Promise.all(
    weekStarts.map(async (ws) => {
      const span = await resolveFinalizeReviewSpan(accountKey, ws, adapter);
      return { ws, weekIndex: span.weekIndex };
    }),
  );
  for (const r of results) {
    if (r.weekIndex === 1 || r.weekIndex === 3) {
      out.set(r.ws, addDaysIso(r.ws, 13));
    } else {
      // weekIndex 2 or 4, or null (own-week fall-back).
      out.set(r.ws, addDaysIso(r.ws, 6));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────

interface BuildPeriodInputs {
  fiscalYear: number;
  periodNo: number;
  window: ReturnType<typeof makePeriodWindow>;
  siteToday: string;
  cadence: "weekly" | "biweekly";
  revenueByDate: Map<string, DailyRevenueLite[]>;
  serviceById: Map<string, ServiceLite>;
  metaByDate: Map<string, DayMetadataLite>;
  finByDate: Map<string, { row: FinalizeLite; spanStart: string; spanLength: number }>;
  phases: PhaseRow[];
  isPeriodClosed: boolean;
  excludedServiceIds: Set<string>;
  isBilled: boolean;
  isCorpViewer: boolean;
  unitEndsByWeekStart: Map<string, string>;
}

function buildPeriodView(x: BuildPeriodInputs): PeriodView {
  const weeks: WeekView[] = x.window.weeks.map((weekDates) => {
    const weekStart = weekDates[0];
    const unitEndIso = x.unitEndsByWeekStart.get(weekStart) ?? addDaysIso(weekStart, 6);
    const days: DayView[] = weekDates.map((iso) => buildDay({
      iso,
      siteToday: x.siteToday,
      revenue: x.revenueByDate.get(iso) ?? [],
      serviceById: x.serviceById,
      meta: x.metaByDate.get(iso) ?? null,
      finOver: x.finByDate.get(iso) ?? null,
      isPeriodClosed: x.isPeriodClosed,
      unitEndIso,
    }));

    const finCoveringThisWeek = days.map((d) => x.finByDate.get(d.iso)).find((f) => !!f) ?? null;

    const isSubmitted = !!finCoveringThisWeek;
    const isPushFailed = !!finCoveringThisWeek && (finCoveringThisWeek.row.status === "push_failed" || finCoveringThisWeek.row.push_gave_up_at !== null);

    const unitEndedBeforeSiteToday = unitEndIso < x.siteToday;

    const isPeriodClosedForEveryDay = x.isPeriodClosed;

    const weekWord = resolveWeekState({
      days,
      isSubmitted,
      isPushFailed,
      isCorpViewer: x.isCorpViewer,
      isPeriodClosedForEveryDay,
      unitEndedBeforeSiteToday,
    });

    // A submitted week carries the day it was submitted: "Submitted Fri,
    // Nov 13", pulled from finalized_at through fmt.ts (short) plus a
    // 3-letter weekday from the Chicago-stable parts of the date.
    const resolvedWord = (weekWord.state === "submitted" && finCoveringThisWeek)
      ? `Submitted ${submittedOnLabel(finCoveringThisWeek.row.finalized_at)}`
      : weekWord.word;

    const hasEntered = days.some((d) => d.state === "entered" || d.state === "part_entered" || d.state === "submitted" || d.state === "closed" || d.state === "not_served");
    const hasService = hasEntered || days.some((d) => d.state === "projected" || d.state === "needs_actuals" || d.state === "no_actuals");

    const meals = hasEntered ? days.reduce((a, d) => a + (d.meals ?? 0), 0) : null;

    // Dollars: only for a billed site AND only when the week has
    // entered days. Each week's dollars are that week's own seven days,
    // never the two-week pair as a whole. The rounding (to the nearest
    // hundred over $100, nearest ten under) lives in shortDollarsFromCents
    // in billable.ts; the loader passes raw cents so the formatter is
    // the one source of truth for how small weeks render.
    let billableCents: number | null = null;
    if (x.isBilled && hasEntered) {
      const rows = weekDates.flatMap((iso) => (x.revenueByDate.get(iso) ?? []).map((r) => ({
        service_id: r.service_id,
        is_non_revenue: r.is_non_revenue,
        has_actuals: r.has_actuals,
        actual_revenue: r.actual_revenue,
      })));
      const cents = sumBillablePretaxCents(rows, x.excludedServiceIds);
      billableCents = cents > 0 ? cents : null;
    }

    const phase = phaseAt(x.phases, weekStart);

    return {
      weekStart,
      dates: weekDates,
      days,
      state: weekWord.state,
      word: resolvedWord,
      tone: weekWord.tone,
      icon: weekWord.icon,
      meals,
      billableCents,
      hasEntered,
      hasService,
      submittedAt: finCoveringThisWeek?.row.finalized_at ?? null,
      phase,
    };
  });

  // "All four weeks submitted" only when at least one week had service
  // AND every week with service has been submitted.
  const weeksWithService = weeks.filter((w) => w.hasService);
  const allSubmitted = weeksWithService.length > 0 &&
    weeksWithService.every((w) => w.state === "submitted" || w.state === "push_failed");

  return {
    fiscalYear: x.fiscalYear,
    periodNo: x.periodNo,
    startIso: x.window.startIso,
    endIso: x.window.endIso,
    weeks,
    isClosed: x.isPeriodClosed,
    allSubmitted,
  };
}

interface BuildDayInputs {
  iso: string;
  siteToday: string;
  revenue: DailyRevenueLite[];
  serviceById: Map<string, ServiceLite>;
  meta: DayMetadataLite | null;
  finOver: { row: FinalizeLite; spanStart: string; spanLength: number } | null;
  isPeriodClosed: boolean;
  unitEndIso: string;
}

function buildDay(x: BuildDayInputs): DayView {
  let hasAnyActualAbove = false;
  let hasAnyActualZero = false;
  let hasAnyProjectedAbove = false;
  let blankProjectedCount = 0;
  let mealsCount = 0;
  let projectedMealsCount = 0;

  for (const r of x.revenue) {
    const svc = x.serviceById.get(r.service_id);
    if (svc && svc.unit === "dollars") continue;
    const act = Number(r.actual_count ?? 0);
    const proj = Number(r.projected_count ?? 0);
    const unitIsMeals = !svc || svc.unit === "meals";

    if (r.has_actuals && !r.has_projection) {
      if (act > 0) {
        hasAnyActualAbove = true;
        if (unitIsMeals) mealsCount += act;
      } else {
        hasAnyActualZero = true;
      }
    } else if (r.has_projection && !r.has_actuals) {
      if (proj > 0) {
        hasAnyProjectedAbove = true;
        blankProjectedCount += 1;
        if (unitIsMeals) projectedMealsCount += proj;
      }
    } else if (r.has_actuals && r.has_projection) {
      if (act > 0) {
        hasAnyActualAbove = true;
        if (unitIsMeals) mealsCount += act;
      } else {
        hasAnyActualZero = true;
      }
      if (proj > 0) {
        hasAnyProjectedAbove = true;
        if (unitIsMeals) projectedMealsCount += proj;
      }
    }
  }

  const unitEndedBeforeSiteToday = x.unitEndIso < x.siteToday;

  const state = resolveDayState({
    hasAnyActualAbove,
    hasAnyActualZero,
    hasAnyProjectedAbove,
    blankProjectedCount,
    reviewStatus: x.meta?.review_status ?? null,
    isInSubmittedSpan: x.finOver !== null,
    isPeriodClosed: x.isPeriodClosed,
    unitEndedBeforeSiteToday,
  });

  const marked = !hasAnyActualAbove && hasAnyActualZero && hasAnyProjectedAbove;
  const meals = hasAnyActualAbove ? mealsCount : marked ? 0 : null;
  const projectedMeals = hasAnyProjectedAbove ? projectedMealsCount : null;

  const home = homeGameFrom(x.meta);

  return {
    iso: x.iso,
    dow: dowOf(x.iso),
    isToday: x.iso === x.siteToday,
    meals,
    projectedMeals,
    marked,
    hasBlankLine: blankProjectedCount > 0,
    home,
    state: state.state,
    word: state.word,
    tone: state.tone,
    icon: state.icon,
  };
}

function homeGameFrom(meta: DayMetadataLite | null): HomeGameMark | null {
  if (!meta) return null;
  if (meta.game_type === "DAY") return { kind: "day", time: meta.game_time ?? null };
  if (meta.game_type === "NIGHT") return { kind: "night", time: meta.game_time ?? null };
  return null;
}

// ─────────────────────────────────────────────────────────────────

interface SquareInputs {
  iso: string;
  siteToday: string;
  revenue: DailyRevenueLite[];
  serviceById: Map<string, ServiceLite>;
  meta: DayMetadataLite | null;
  finOver: { row: FinalizeLite; spanStart: string; spanLength: number } | null;
  isPeriodClosed: boolean;
  unitEndIso: string;
}

function squareFor(x: SquareInputs): YearSquare {
  const d = buildDay({
    iso: x.iso,
    siteToday: x.siteToday,
    revenue: x.revenue,
    serviceById: x.serviceById,
    meta: x.meta,
    finOver: x.finOver,
    isPeriodClosed: x.isPeriodClosed,
    unitEndIso: x.unitEndIso,
  });
  // "Any entered value" is "any actuals row above 0" on this day,
  // whether or not that row counts in meals. A not-served day (every
  // projected line answered with 0) does NOT set this; a day with only
  // non-meal lines (pans, each, days) DOES.
  let hasAnyEnteredValue = false;
  for (const r of x.revenue) {
    const svc = x.serviceById.get(r.service_id);
    if (svc && svc.unit === "dollars") continue;
    if (r.has_actuals && Number(r.actual_count ?? 0) > 0) {
      hasAnyEnteredValue = true;
      break;
    }
  }
  return {
    iso: x.iso,
    meals: d.meals ?? 0,
    state: d.state,
    isToday: d.isToday,
    isHome: d.home !== null,
    hasAnyEnteredValue,
  };
}

function mondayFrom(iso: string): string {
  const dow = dowOf(iso);
  return addDaysIso(iso, -dow);
}

function phaseAt(phases: PhaseRow[], iso: string): string | null {
  for (const p of phases) {
    if (iso >= p.startIso && iso <= p.endIso) return p.phase;
  }
  return null;
}

function findFailedPush(
  period: PeriodView,
  spans: { row: FinalizeLite; dates: Set<string>; spanStart: string; spanLength: number }[],
): string | null {
  const rangeStart = period.startIso;
  const rangeEnd = period.endIso;
  const failed = spans
    .filter((s) => s.row.status === "push_failed" || s.row.push_gave_up_at !== null)
    .filter((s) => s.spanStart >= rangeStart && s.spanStart <= rangeEnd)
    .sort((a, b) => (a.spanStart < b.spanStart ? 1 : a.spanStart > b.spanStart ? -1 : 0));
  return failed[0]?.spanStart ?? null;
}

// "Fri, Nov 13" from a timestamptz. Chicago-stable via fmtDate("short"),
// and the 3-letter weekday from Intl in Chicago so the day never shifts.
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function submittedOnLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(t));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  if (!wd || !m || !d) return iso;
  // If Intl uses "Friday" fallback for some locales, cut to three letters.
  const wd3 = wd.length > 3 ? wd.slice(0, 3) : wd;
  // Sanity against DOW_SHORT so a hostile locale cannot slip a long word in.
  const safe = DOW_SHORT.includes(wd3) ? wd3 : wd3;
  return `${safe}, ${m} ${d}`;
}

function emptyYearView(viewer: ViewerLite, site: SiteInfo, siteToday: string, fiscalYear: number): CalendarView {
  const emptyPeriod: PeriodView = {
    fiscalYear,
    periodNo: 1,
    startIso: siteToday,
    endIso: siteToday,
    weeks: [],
    isClosed: false,
    allSubmitted: false,
  };
  return {
    viewer,
    site,
    today: siteToday,
    period: emptyPeriod,
    year: { fiscalYear, cards: [], totals: { entered: 0, meals: 0 } },
    failedPushWeekStart: null,
  };
}
