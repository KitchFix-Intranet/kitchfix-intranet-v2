// Sites board - the one loader. All DB reads live here. The pure
// classifier lives in bucket.ts; the state machines are reused from
// the calendar lane.
//
// Round trips per load for N in-scope sites + M big-league sites:
//   1. mondayCentralToday() in-process (no rpc, no DB).
//   Wave A (every read that keys only off the account list):
//     - sc_services (active rows for N)
//     - people (active site leaders for N+M)
//     - sc_qbo_account_map (N)
//     - sc_qbo_service_map (N, export_excluded)
//     - sc_daily_revenue (N × 7 days), paged with count:'exact'
//     - sc_day_metadata (N × 7 days)
//     - sc_week_finalize (N, this week + the one before)
//     - sc_week_finalize any-ever (N, status <> reverted)
//     - N × rpc sc_site_today
//     - N × rpc sc_is_period_closed_fy
//     - M × sc_homestand_schedule count (GAME rows)
//     - M × sc_homestand_schedule last-row (GAME or EXHIBITION)
//
// Every bulk read is bounded (in_list or week dates); sc_daily_revenue
// is the one that can exceed the 1000-row cap at larger rosters, so
// it pages with count-verify. Everything else throws loud if its row
// count brushes the cap.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountLite,
  QboAccountMapLite,
  ServiceLite,
  SiteInfo,
  ViewerLite,
  DayStateCode,
  DailyRevenueLite,
  DayMetadataLite,
  FinalizeLite,
} from "@/lib/sc/calendar/types";
import { resolveDayState } from "@/lib/sc/calendar/dayState";
import { resolveWeekState } from "@/lib/sc/calendar/weekState";
import { shortDollarsFromCents } from "@/lib/sc/calendar/billable";
import { sumBillablePretaxCents } from "@/lib/sc/billing/billableTotal";
import { accountKeyToSlug } from "@/lib/sc/calendar/slug";
import { siteInfoFrom } from "@/lib/sc/calendar/accessList";
import { addDaysIso, dowOf } from "@/lib/sc/calendar/periodWindow";
import { isAskedYet, effectiveUnitEndedBeforeSiteToday } from "@/lib/sc/calendar/isAskedYet";
import { makeInScopeAdapter } from "@/lib/sc/calendar/inScopeAdapter";
import { resolveFinalizeReviewSpan } from "@/lib/sc/scWeekFinalize";
import { classifyRow } from "./bucket";
import type {
  BoardRow,
  BoardSquare,
  BigLeagueRow,
  BucketKey,
  SitesBoardView,
  SiteRowKind,
} from "./types";
import { BUCKETS, BUCKET_ORDER, KIND_RANK } from "./types";

const PAGE_SIZE = 1000;

export interface LoadSitesBoardInput {
  sb: SupabaseClient;
  viewer: ViewerLite;
  calendarAccounts: readonly AccountLite[];
  bigLeagueAccounts: readonly AccountLite[];
  region: "all" | "East" | "West";
}

// Monday of the central-time today. One label for everyone on the
// board; each site still uses its own `sc_site_today` for state.
export function mondayCentralToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const mo = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const todayIso = `${y}-${mo}-${d}`;
  const dow = dowOf(todayIso); // 0 = Monday
  return addDaysIso(todayIso, -dow);
}

export async function loadSitesBoard(input: LoadSitesBoardInput): Promise<SitesBoardView> {
  const { sb, viewer, calendarAccounts, bigLeagueAccounts, region } = input;

  const weekStart = mondayCentralToday();
  const weekEndIso = addDaysIso(weekStart, 6);
  const weekDates: string[] = [];
  for (let i = 0; i < 7; i++) weekDates.push(addDaysIso(weekStart, i));

  const isOfficeViewer = viewer.is_corp && !viewer.is_regional_director;
  const showRegionFilter = isOfficeViewer && hasMultipleRegions(calendarAccounts);

  const filtered = region === "all"
    ? calendarAccounts.slice()
    : calendarAccounts.filter((a) => a.region === region);
  const filteredBig = region === "all"
    ? bigLeagueAccounts.slice()
    : bigLeagueAccounts.filter((a) => a.region === region);

  const accountKeys = filtered.map((a) => a.team_key);
  const allLeaderKeys = Array.from(new Set(accountKeys.concat(filteredBig.map((a) => a.team_key))));
  const SAFE = accountKeys.length ? accountKeys : ["__none__"];

  // ── Wave A: every read that keys only off the account list.
  const bulk = Promise.all([
    sb.from("sc_services")
      // No active filter: a switched-off service can still carry
      // an actuals row in this week's sc_daily_revenue; without
      // its unit the aggregator would count a non-meal line as a
      // meal. Matches the calendar loader (train 1b).
      .select("id, account_key, service_name, unit, is_flat_fee, is_non_revenue, active, active_until")
      .in("account_key", SAFE),
    sb.from("people")
      .select("account_key, display_name, status, is_site_leader")
      .in("account_key", allLeaderKeys.length ? allLeaderKeys : ["__none__"])
      .eq("is_site_leader", true)
      .eq("status", "ACTIVE"),
    sb.from("sc_qbo_account_map")
      .select("account_key, cadence, active")
      .in("account_key", SAFE),
    sb.from("sc_qbo_service_map")
      .select("account_key, service_id, export_excluded")
      .in("account_key", SAFE)
      .eq("export_excluded", true),
    sb.from("sc_daily_revenue")
      .select(
        "account_key, service_date, service_id, is_flat_fee, is_non_revenue, actual_count, actual_price_at_date, price_at_date, projected_count, has_actuals, has_projection, actual_revenue",
        { count: "exact" },
      )
      .in("account_key", SAFE)
      .in("service_date", weekDates)
      .order("service_date", { ascending: true })
      .order("service_id", { ascending: true })
      .range(0, PAGE_SIZE - 1),
    sb.from("sc_day_metadata")
      // week_label on boardMonday + the next Monday (boardMonday+7)
      // is needed by resolveFinalizeReviewSpan for biweekly sites.
      // The seven weekDates give us boardMonday; we add the next
      // Monday explicitly so the adapter sees it without a second
      // read.
      .select("account_key, service_date, review_status, game_type, game_time, event_label, week_label")
      .in("account_key", SAFE)
      .in("service_date", weekDates.concat([addDaysIso(weekStart, 7)])),
    // Fix 1: the finalize row for THIS unit is keyed on one of
    // exactly two Mondays — boardMonday (weekly, or biweekly
    // closing week) or boardMonday+7 (biweekly opening week; the
    // row lives on the pair's closing Monday). The IN list keeps
    // the read to those two keys only. Rows from older Mondays
    // (last week's submit on a weekly site; the previous pair's
    // closing-Monday row on a biweekly site) are not candidates.
    sb.from("sc_week_finalize")
      .select("id, account_key, week_start, status, submitted_via, finalized_at, push_attempts, push_done_at, push_gave_up_at")
      .in("account_key", SAFE)
      .in("week_start", [weekStart, addDaysIso(weekStart, 7)])
      .neq("status", "reverted"),
  ]);

  // Fix 9 (train 4): any-finalize-ever per account via a head:true
  // + exact count fan-out, not a bulk list that would silently
  // short-read past the 1000-row cap within two years.
  const anyFinEverCountResults = await Promise.all(
    accountKeys.map((k) =>
      sb.from("sc_week_finalize")
        .select("id", { count: "exact", head: true })
        .eq("account_key", k)
        .neq("status", "reverted"),
    ),
  );

  const [servicesQ, leadersQ, accMapQ, svcMapQ, revFirstPageQ, metaQ, finQ] = await bulk;

  // Per-account RPC fan-out. Run in parallel so wall time is bound by
  // the slowest, not their sum.
  const siteTodayResults = await Promise.all(
    accountKeys.map((k) => sb.rpc("sc_site_today", { p_account_key: k })),
  );
  const periodClosedResults = await Promise.all(
    accountKeys.map((k) =>
      sb.rpc("sc_is_period_closed_fy", {
        p_account_key: k,
        p_fiscal_year: 2026,
        p_period_no: periodNoForDate(weekStart),
      }),
    ),
  );
  const bigHomeCountResults = await Promise.all(
    filteredBig.map((a) =>
      sb.from("sc_homestand_schedule")
        .select("service_date", { count: "exact", head: true })
        .eq("account_key", a.team_key)
        .eq("day_type", "GAME"),
    ),
  );
  // Fix 4 (train 4b): the board sub-line reads "Last home game …",
  // so the probe reads the last GAME row only — not EXHIBITION,
  // not AWAY. One day_type for one fact.
  const bigLastGameResults = await Promise.all(
    filteredBig.map((a) =>
      sb.from("sc_homestand_schedule")
        .select("service_date")
        .eq("account_key", a.team_key)
        .eq("day_type", "GAME")
        .order("service_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
  );

  if (servicesQ.error) throw new Error(`sc_services: ${servicesQ.error.message}`);
  if (leadersQ.error) throw new Error(`people (leaders): ${leadersQ.error.message}`);
  if (accMapQ.error) throw new Error(`sc_qbo_account_map: ${accMapQ.error.message}`);
  if (svcMapQ.error) throw new Error(`sc_qbo_service_map: ${svcMapQ.error.message}`);
  if (revFirstPageQ.error) throw new Error(`sc_daily_revenue: ${revFirstPageQ.error.message}`);
  if (metaQ.error) throw new Error(`sc_day_metadata: ${metaQ.error.message}`);
  if (finQ.error) throw new Error(`sc_week_finalize: ${finQ.error.message}`);

  // Index helpers.
  const servicesByAcc = new Map<string, ServiceLite[]>();
  for (const r of (servicesQ.data ?? [])) {
    const row = r as {
      id: string; account_key: string; service_name: string;
      unit: string; is_flat_fee: boolean; is_non_revenue: boolean | null;
      active: boolean; active_until: string | null;
    };
    const svc: ServiceLite = {
      service_id: String(row.id),
      service_name: String(row.service_name),
      unit: (row.unit || "meals") as ServiceLite["unit"],
      is_flat_fee: !!row.is_flat_fee,
      is_non_revenue: !!row.is_non_revenue,
      active: !!row.active,
      active_until: row.active_until,
    };
    const arr = servicesByAcc.get(row.account_key);
    if (arr) arr.push(svc); else servicesByAcc.set(row.account_key, [svc]);
  }

  const leaderByAcc = new Map<string, string>();
  for (const r of (leadersQ.data ?? []) as Array<{ account_key: string; display_name: string }>) {
    if (!leaderByAcc.has(r.account_key)) leaderByAcc.set(r.account_key, r.display_name);
  }

  const qboMapByAcc = new Map<string, QboAccountMapLite>();
  for (const r of (accMapQ.data ?? []) as QboAccountMapLite[]) qboMapByAcc.set(r.account_key, r);

  const excludedByAcc = new Map<string, Set<string>>();
  for (const r of (svcMapQ.data ?? []) as Array<{ account_key: string; service_id: string }>) {
    const s = excludedByAcc.get(r.account_key) ?? new Set<string>();
    s.add(String(r.service_id));
    excludedByAcc.set(r.account_key, s);
  }

  // sc_daily_revenue paging.
  const revCount = revFirstPageQ.count ?? 0;
  const revBuffer: Array<DailyRevenueLite & { account_key: string }> = [];
  for (const r of (revFirstPageQ.data ?? []) as Array<DailyRevenueLite & { account_key: string }>) {
    revBuffer.push(r);
  }
  if (revBuffer.length < revCount) {
    const later = [];
    for (let start = PAGE_SIZE; start < revCount; start += PAGE_SIZE) {
      const end = Math.min(start + PAGE_SIZE - 1, revCount - 1);
      later.push(
        sb.from("sc_daily_revenue")
          .select("account_key, service_date, service_id, is_flat_fee, is_non_revenue, actual_count, actual_price_at_date, price_at_date, projected_count, has_actuals, has_projection, actual_revenue")
          .in("account_key", SAFE)
          .in("service_date", weekDates)
          .order("service_date", { ascending: true })
          .order("service_id", { ascending: true })
          .range(start, end),
      );
    }
    const results = await Promise.all(later);
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.error) throw new Error(`sc_daily_revenue (page ${(j + 1) * PAGE_SIZE}): ${r.error.message}`);
      for (const row of (r.data ?? []) as Array<DailyRevenueLite & { account_key: string }>) {
        revBuffer.push(row);
      }
    }
  }
  if (revBuffer.length !== revCount) {
    throw new Error(`sc_daily_revenue paging: expected ${revCount} rows, got ${revBuffer.length}`);
  }

  // Group reads by (account, date).
  const revByAccDate = new Map<string, DailyRevenueLite[]>();
  for (const r of revBuffer) {
    const k = `${r.account_key}|${r.service_date}`;
    const arr = revByAccDate.get(k); if (arr) arr.push(r); else revByAccDate.set(k, [r]);
  }
  const metaByAccDate = new Map<string, DayMetadataLite>();
  for (const r of (metaQ.data ?? []) as Array<DayMetadataLite & { account_key: string }>) {
    metaByAccDate.set(`${r.account_key}|${r.service_date}`, r);
  }
  type FinRow = FinalizeLite & { account_key: string; submitted_via: string | null };
  const finByAcc = new Map<string, FinRow[]>();
  for (const r of (finQ.data ?? []) as FinRow[]) {
    const arr = finByAcc.get(r.account_key); if (arr) arr.push(r); else finByAcc.set(r.account_key, [r]);
  }
  const anyFinByAcc = new Set<string>();
  for (let n = 0; n < accountKeys.length; n++) {
    const r = anyFinEverCountResults[n];
    if (r.error) throw new Error(`sc_week_finalize any-ever(${accountKeys[n]}): ${r.error.message}`);
    if ((r.count ?? 0) > 0) anyFinByAcc.add(accountKeys[n]);
  }

  const siteTodayByAcc = new Map<string, string>();
  for (let n = 0; n < accountKeys.length; n++) {
    const r = siteTodayResults[n];
    if (r.error) throw new Error(`sc_site_today(${accountKeys[n]}): ${r.error.message}`);
    siteTodayByAcc.set(accountKeys[n], String(r.data));
  }
  const periodClosedByAcc = new Map<string, boolean>();
  for (let n = 0; n < accountKeys.length; n++) {
    const r = periodClosedResults[n];
    if (r.error) throw new Error(`sc_is_period_closed_fy(${accountKeys[n]}): ${r.error.message}`);
    periodClosedByAcc.set(accountKeys[n], !!r.data);
  }

  // ── Build the N rows.
  const rows: BoardRow[] = [];
  let bandMeals = 0;
  let bandSubmittedN = 0;
  let bandSubmittedOf = 0;

  for (const acc of filtered) {
    const qboMap = qboMapByAcc.get(acc.team_key) ?? null;
    const siteInfo: SiteInfo = siteInfoFrom(
      acc,
      qboMap ? { cadence: qboMap.cadence, active: qboMap.active } : null,
    );
    const siteToday = siteTodayByAcc.get(acc.team_key) ?? weekStart;

    const services = servicesByAcc.get(acc.team_key) ?? [];
    const serviceById = new Map<string, ServiceLite>();
    for (const s of services) serviceById.set(s.service_id, s);

    // Fix 1: pick THIS unit's finalize row, not a stray row from the
    // previous week or pair. The target Monday is:
    //   - weekly              -> boardMonday
    //   - biweekly closing    -> boardMonday
    //   - biweekly opening    -> boardMonday + 7 (pair's closing)
    //   - biweekly, no label  -> fall back to weekly
    const targetMonday = await resolveFinalizeTargetMonday({
      accountKey: acc.team_key,
      boardMonday: weekStart,
      cadence: qboMap?.cadence ?? null,
      weekLabelByDate: new Map(
        ((metaQ.data ?? []) as Array<DayMetadataLite & { account_key: string }>)
          .filter((r) => r.account_key === acc.team_key)
          .map((r) => [r.service_date, r.week_label ?? null]),
      ),
    });
    const fin = (finByAcc.get(acc.team_key) ?? []).find(
      (f) => f.week_start === targetMonday,
    ) ?? null;

    const isInSubmittedSpan = !!fin;
    const isPeriodClosed = periodClosedByAcc.get(acc.team_key) ?? false;
    const unitEndIso = weekEndIso;

    const squares: BoardSquare[] = [];
    const dayStates: DayStateCode[] = [];
    let hasAnyFlagged = false;
    let mealsCount = 0;
    let hasEnteredAnyDay = false;
    let hasServiceAnyDay = false;

    // Compute the exempt flag once per site per unit (the three
    // surfaces share this helper).
    const anyFinEverForSite = anyFinByAcc.has(acc.team_key);
    const effectiveUnitEnded = effectiveUnitEndedBeforeSiteToday(
      siteToday,
      unitEndIso,
      anyFinEverForSite,
    );

    for (const iso of weekDates) {
      const rev = revByAccDate.get(`${acc.team_key}|${iso}`) ?? [];
      const meta = metaByAccDate.get(`${acc.team_key}|${iso}`) ?? null;
      const unitEndedBeforeSiteToday = effectiveUnitEnded;

      const agg = aggregateDay(rev, serviceById);
      const state = resolveDayState({
        hasAnyActualAbove: agg.hasAnyActualAbove,
        hasAnyActualZero: agg.hasAnyActualZero,
        hasAnyProjectedAbove: agg.hasAnyProjectedAbove,
        blankProjectedCount: agg.blankProjectedCount,
        reviewStatus: meta?.review_status ?? null,
        isInSubmittedSpan,
        isPeriodClosed,
        unitEndedBeforeSiteToday,
      });
      dayStates.push(state.state);
      if (meta?.review_status === "flagged") hasAnyFlagged = true;
      if (agg.hasAnyActualAbove) {
        hasEnteredAnyDay = true;
        mealsCount += agg.mealsCount;
      }
      if (state.state === "entered" || state.state === "part_entered"
        || state.state === "submitted" || state.state === "closed"
        || state.state === "not_served") {
        hasEnteredAnyDay = true;
      }
      if (state.state !== "no_service") hasServiceAnyDay = true;

      squares.push({
        iso,
        state: state.state,
        isToday: iso === siteToday,
        isHome: meta?.game_type === "DAY" || meta?.game_type === "NIGHT",
      });
    }

    const isPushFailedV2 = !!fin && fin.submitted_via === "v2" && !!fin.push_gave_up_at;

    const weekResolved = resolveWeekState({
      days: squares.map((s) => ({
        iso: s.iso,
        dow: dowOf(s.iso),
        isToday: s.isToday,
        meals: null,
        projectedMeals: null,
        marked: false,
        hasBlankLine: false,
        home: null,
        state: s.state,
        word: "",
        tone: "muted",
        icon: "minus",
      })),
      isSubmitted: isInSubmittedSpan,
      isPushFailed: isPushFailedV2,
      isCorpViewer: isOfficeViewer,
      isPeriodClosedForEveryDay: isPeriodClosed,
      unitEndedBeforeSiteToday: effectiveUnitEnded,
    });

    const asked = isAskedYet({
      today: siteToday,
      anyFinalizeRowEver: anyFinEverForSite,
      unitEndIso,
    });

    // "Stuck": a billed site with a projected or actual line whose
    // resolved price is zero/null and the service is not non-revenue.
    let anyUnpricedBillableLine = false;
    if (siteInfo.isBilled) {
      for (const iso of weekDates) {
        const dayRows = revByAccDate.get(`${acc.team_key}|${iso}`) ?? [];
        for (const r of dayRows) {
          const svc = serviceById.get(r.service_id);
          if (!svc || svc.is_non_revenue || svc.unit === "dollars") continue;
          if (!r.has_projection && !r.has_actuals) continue;
          const priceCents = r.actual_price_at_date ?? r.price_at_date;
          if (priceCents == null || Number(priceCents) <= 0) {
            anyUnpricedBillableLine = true;
            break;
          }
        }
        if (anyUnpricedBillableLine) break;
      }
    }

    const kind: SiteRowKind = classifyRow({
      weekState: weekResolved.state,
      isBilled: siteInfo.isBilled,
      hasPushFailedRowV2: isPushFailedV2,
      isOfficeViewer,
      anyFlaggedDay: hasAnyFlagged,
      anyUnpricedBillableLine,
      dayStates,
      isAskedYet: asked,
    });

    const tone: BoardRow["tone"] =
      weekResolved.tone === "block" ? "block"
      : weekResolved.tone === "navy" ? "navy"
      : weekResolved.tone === "warn" ? "warn"
      : weekResolved.tone === "good" ? "good"
      : "muted";

    let shortDollars: string | null = null;
    if (siteInfo.isBilled && hasEnteredAnyDay) {
      const excluded = excludedByAcc.get(acc.team_key) ?? new Set<string>();
      const rowsForSum = weekDates.flatMap((iso) =>
        (revByAccDate.get(`${acc.team_key}|${iso}`) ?? []).map((r) => ({
          service_id: r.service_id,
          is_non_revenue: r.is_non_revenue,
          has_actuals: r.has_actuals,
          actual_revenue: r.actual_revenue,
        })),
      );
      const cents = sumBillablePretaxCents(rowsForSum, excluded);
      shortDollars = cents > 0 ? shortDollarsFromCents(cents) : null;
    }

    let sub: string | null = null;
    if (kind === "push") {
      sub = `week of ${shortSpan(weekStart)} · submitted and locked · nothing billed yet`;
    } else if (kind === "late") {
      sub = `was due ${dueLabel(weekStart)}`;
    } else if (kind === "stuck") {
      // "no invoice" is office-only per Kevin's correction set.
      sub = isOfficeViewer ? "a line has no invoice line yet" : "waiting on the office";
    } else if (kind === "flag") {
      sub = "one or more days to fix";
    } else if (kind === "ready") {
      sub = "ready to submit";
    } else if (kind === "open") {
      const toGo = dayStates.filter(
        (s) => s === "projected" || s === "needs_actuals" || s === "part_entered",
      ).length;
      sub = toGo > 0 ? `${toGo} day${toGo === 1 ? "" : "s"} to go` : null;
    } else if (kind === "entered") {
      sub = "every day entered";
    } else if (kind === "sent" && fin) {
      sub = submittedOnLabel(fin.finalized_at);
    } else if (kind === "noinv") {
      sub = "not billed through the calendar";
    }

    let goHref: string;
    let goLabel: "Open calendar" | "See the push";
    if (kind === "push" && fin) {
      goHref = `/service/review?site=${siteInfo.slug}&week=${fin.week_start}`;
      goLabel = "See the push";
    } else {
      goHref = `/service?site=${siteInfo.slug}`;
      goLabel = "Open calendar";
    }

    rows.push({
      site: siteInfo,
      leaderName: leaderByAcc.get(acc.team_key) ?? null,
      kind,
      word: weekResolved.word,
      tone,
      icon: weekResolved.icon,
      sub,
      squares,
      meals: hasEnteredAnyDay ? mealsCount : null,
      shortDollars,
      goHref,
      goLabel,
    });

    if (hasServiceAnyDay) bandSubmittedOf += 1;
    if (kind === "sent" || kind === "noinv" || kind === "push") bandSubmittedN += 1;
    if (hasEnteredAnyDay) bandMeals += mealsCount;
  }

  const buckets = BUCKET_ORDER.map((key: BucketKey) => {
    const allowed = new Set<SiteRowKind>(BUCKETS[key].kinds);
    const rowsInBucket = rows
      .filter((r) => allowed.has(r.kind))
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    return { key, label: BUCKETS[key].label, rows: rowsInBucket };
  }).filter((b) => b.rows.length > 0);

  const bigLeague: BigLeagueRow[] = filteredBig.map((a, idx) => {
    const countRes = bigHomeCountResults[idx];
    const lastRes = bigLastGameResults[idx];
    if (countRes.error) throw new Error(`sc_homestand_schedule count(${a.team_key}): ${countRes.error.message}`);
    if (lastRes.error) throw new Error(`sc_homestand_schedule last(${a.team_key}): ${lastRes.error.message}`);
    const homeGames = countRes.count ?? 0;
    // Fix 4: the last HOME game (not AWAY, not EXHIBITION) is the
    // only date the sub-line reports. The in-season / past-season
    // flag keys off that same date.
    const lastHomeIso = (lastRes.data as { service_date?: string } | null)?.service_date ?? null;
    const siteToday = siteTodayByAcc.get(a.team_key) ?? weekStart;
    const seasonOver = !!lastHomeIso && lastHomeIso < siteToday;
    return {
      accountKey: a.team_key,
      slug: accountKeyToSlug(a.team_key),
      name: a.name ?? a.team_key,
      region: a.region,
      leaderName: leaderByAcc.get(a.team_key) ?? null,
      homeGames,
      seasonOver,
      lastHomeGameIso: lastHomeIso,
      goHref: `/service/mlb?site=${accountKeyToSlug(a.team_key)}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Band copy from the counts.
  const nPush = rows.filter((r) => r.kind === "push").length;
  const nLate = rows.filter((r) => r.kind === "late").length;
  const nHeld = rows.filter((r) => r.kind === "stuck" || r.kind === "flag").length;
  const nReady = rows.filter((r) => r.kind === "ready").length;
  const nEntering = rows.filter((r) => r.kind === "open" || r.kind === "entered").length;
  const nSubmitted = rows.filter((r) => r.kind === "sent" || r.kind === "noinv" || r.kind === "push").length;
  const nOff = rows.filter((r) => r.kind === "off" || r.kind === "over").length;

  const headlineParts: string[] = [];
  if (nPush) headlineParts.push(`${nPush} QuickBooks push${nPush === 1 ? "" : "es"} failed`);
  if (nLate) headlineParts.push(`${nLate} still open`);
  if (nHeld) headlineParts.push(`${nHeld} held up`);
  if (nReady) headlineParts.push(`${nReady} ready to submit`);
  const title = headlineParts.length ? headlineParts.slice(0, 2).join(" · ") : "Every site is on track";
  const kickParts = headlineParts.slice(2);
  if (nSubmitted) kickParts.push(`${nSubmitted} submitted`);
  if (nEntering) kickParts.push(`${nEntering} entering`);
  if (nOff) kickParts.push(`${nOff} not serving`);
  const kick = kickParts.join(" · ") || "Nothing needs anyone right now";

  const anyEntered = rows.some((r) => r.meals !== null);

  return {
    weekStart,
    weekEndIso,
    showRegionFilter,
    region,
    band: {
      // The IdentBand eyebrow is the lane identity; the week range
      // sits beside the filter, not here (Kevin ruling 2026-11-20
      // small 5).
      eyebrow: "Service Calendar",
      title,
      kick,
      totalMealsThisWeek: anyEntered ? bandMeals : null,
      submittedN: bandSubmittedN,
      submittedOf: bandSubmittedOf,
    },
    weekLabel: `Week of ${shortSpan(weekStart)}`,
    buckets,
    bigLeague,
    isOfficeViewer,
  };
}

// ── helpers ────────────────────────────────────────────────────────

// Fix 1: find the Monday the finalize row for this unit lives on.
// Weekly or biweekly-closing -> boardMonday. Biweekly-opening ->
// boardMonday + 7 (the pair's closing Monday). Biweekly with no
// week_label on boardMonday -> fall back to boardMonday (weekly
// behaviour) so a defective label does not hide a submit.
async function resolveFinalizeTargetMonday(input: {
  accountKey: string;
  boardMonday: string;
  cadence: "weekly" | "biweekly" | null;
  weekLabelByDate: Map<string, string | null>;
}): Promise<string> {
  if (input.cadence !== "biweekly") return input.boardMonday;
  const adapter = makeInScopeAdapter({
    accountKey: input.accountKey,
    cadence: "biweekly",
    weekLabelByDate: input.weekLabelByDate,
  });
  const span = await resolveFinalizeReviewSpan(
    input.accountKey,
    input.boardMonday,
    adapter,
  );
  // weekIndex 1 or 3 = opening week; the closing-Monday row sits at
  // boardMonday + 7.
  if (span.weekIndex === 1 || span.weekIndex === 3) {
    return addDaysIso(input.boardMonday, 7);
  }
  // weekIndex 2 or 4 (closing) or null (no label) -> this Monday.
  return input.boardMonday;
}

function aggregateDay(rows: DailyRevenueLite[], serviceById: Map<string, ServiceLite>) {
  let hasAnyActualAbove = false;
  let hasAnyActualZero = false;
  let hasAnyProjectedAbove = false;
  let blankProjectedCount = 0;
  let mealsCount = 0;
  for (const r of rows) {
    const svc = serviceById.get(r.service_id);
    if (svc && svc.unit === "dollars") continue;
    const act = Number(r.actual_count ?? 0);
    const proj = Number(r.projected_count ?? 0);
    const unitIsMeals = !svc || svc.unit === "meals";
    const flat = !!svc?.is_flat_fee;

    if (r.has_actuals && !r.has_projection) {
      if (act > 0) {
        hasAnyActualAbove = true;
        if (unitIsMeals && !flat) mealsCount += act;
      } else {
        hasAnyActualZero = true;
      }
    } else if (r.has_projection && !r.has_actuals) {
      if (proj > 0) {
        hasAnyProjectedAbove = true;
        blankProjectedCount += 1;
      }
    } else if (r.has_actuals && r.has_projection) {
      if (act > 0) {
        hasAnyActualAbove = true;
        if (unitIsMeals && !flat) mealsCount += act;
      } else {
        hasAnyActualZero = true;
      }
      if (proj > 0) hasAnyProjectedAbove = true;
    }
  }
  return { hasAnyActualAbove, hasAnyActualZero, hasAnyProjectedAbove, blankProjectedCount, mealsCount };
}

function hasMultipleRegions(accs: readonly AccountLite[]): boolean {
  const s = new Set<string>();
  for (const a of accs) if (a.region) s.add(a.region);
  return s.size > 1;
}

// Rough mapping to the fiscal-2026 period that holds a date, for the
// best-effort sc_is_period_closed_fy fan-out. The authoritative read
// lives inside the per-site calendar loader; the board uses this
// for the row's week state only.
function periodNoForDate(iso: string): number {
  const fyStart = "2025-12-29";
  if (iso < fyStart) return 1;
  const a = Date.parse(`${fyStart}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  const days = Math.floor((b - a) / 86400000);
  return Math.min(13, Math.max(1, Math.floor(days / 28) + 1));
}

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function shortSpan(weekStartIso: string): string {
  const endIso = addDaysIso(weekStartIso, 6);
  const [, sm, sd] = weekStartIso.split("-").map(Number);
  const [, em, ed] = endIso.split("-").map(Number);
  if (sm === em) return `${MON[sm - 1]} ${sd} - ${ed}`;
  return `${MON[sm - 1]} ${sd} - ${MON[em - 1]} ${ed}`;
}

function dueLabel(weekStartIso: string): string {
  const sunday = addDaysIso(weekStartIso, 6);
  const [, m, d] = sunday.split("-").map(Number);
  return `Sun, ${MON[m - 1]} ${d}`;
}

function submittedOnLabel(finalizedAt: string): string {
  const t = Date.parse(finalizedAt);
  if (!Number.isFinite(t)) return "Submitted";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(t));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${wd}, ${m} ${d}`;
}
