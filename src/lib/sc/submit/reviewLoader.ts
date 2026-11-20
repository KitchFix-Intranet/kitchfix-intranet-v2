// reviewLoader - the week check screen's one source of truth for
// day lines, totals, state words, and called-out reasons.
//
// Round 2 design notes (after the live-look checks):
//
// - The finalize row for a biweekly site is keyed on the CLOSING
//   week's Monday (Week 2 or Week 4). The page is opened with that
//   Monday (`?week=<closingMonday>`); the finalize lookup and the
//   submit POST both key on the SAME Monday, and the span around
//   it is resolved via resolveFinalizeReviewSpan for the day grid.
//
// - Day word comes from the SHARED resolveDayState, same as the
//   calendar + day form. One state machine for the lane.
//
// - Dollars come from sc_daily_revenue.actual_revenue (the view),
//   not count * latest-price here. Keeps the week check byte-aligned
//   with the invoice built downstream even if a price changes
//   mid-unit. Prices still display from sc_service_prices.
//
// - Line order is the catalog's sort_order, not alphabet.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ViewerLite, SiteInfo } from "@/lib/sc/calendar/types";
import type { SubmitBlock } from "@/lib/sc/types";
import { resolveFinalizeReviewSpan, mondayOfWeek } from "@/lib/sc/scWeekFinalize";
import { checkWeekSubmittable } from "@/lib/sc/submit/checkSubmit";
import { resolveDayState } from "@/lib/sc/calendar/dayState";

export interface ReviewLine {
  serviceId: string;
  serviceName: string;
  groupName: string | null;
  isFlatFee: boolean;
  isNonRevenue: boolean;
  unit: "meals" | "each" | "pans" | "days" | "dollars";
  actualCount: number;
  priceCents: number | null;
  beforeTaxCents: number | null;   // null when non-revenue
  isNotBilled: boolean;
  sortOrder: number;
}

export type ReviewLookReason =
  | { kind: "future"; dayWord: string }
  | { kind: "entered_ahead"; onLabel: string }
  | { kind: "slipped"; serviceName: string; actual: number; projected: number };

export interface ReviewDay {
  iso: string;
  dowShort: string;
  dowLong: string;
  dateLabel: string;
  stateCode:
    | "entered" | "part_entered" | "not_served" | "projected"
    | "no_service" | "needs_fix" | "no_actuals" | "submitted" | "closed"
    | "needs_actuals";
  stateWord: string;
  dayMeals: number;
  dayCents: number | null;
  lines: ReviewLine[];
  notServedNames: string[];
  blankProjectedNames: string[];
  isFlagged: boolean;
  // Rule 5 look reasons. Empty = ordinary day. Non-empty = the
  // operator must tick "Looks right" before Submit can light.
  lookReasons: ReviewLookReason[];
}

export interface ReviewTotals {
  totalMeals: number;
  totalCents: number;
}

export interface ReviewView {
  viewer: ViewerLite;
  site: SiteInfo;
  weekStart: string;               // the Monday the caller passed
  unitStart: string;               // first day of the submit unit
  unitEnd: string;
  isBiweeklyUnit: boolean;
  isAlreadySubmitted: boolean;
  submittedAt: string | null;
  days: ReviewDay[];
  totalMeals: number;
  totalCents: number;              // 0 when not billed
  isBilled: boolean;
  preflight: SubmitBlock[];
  siteToday: string;
}

interface SvcRow {
  id: string;
  service_name: string;
  group_id: string | null;
  unit: string;
  is_flat_fee: boolean;
  is_non_revenue: boolean;
  sort_order: number | null;
}
interface GroupRow { id: string; group_name: string; }
interface ActualRow { service_id: string; service_date: string; actual_count: number | null; updated_at: string | null; }
interface ProjRow   { service_id: string; service_date: string; projected_count: number | null; }
interface MetaRow   { service_date: string; review_status: string | null; }
interface PriceRow  { service_id: string; price: number | null; effective_date: string; }
interface RevRow    { service_date: string; service_id: string; actual_revenue: number | null; is_non_revenue: boolean | null; has_actuals: boolean | null; }

const DOW_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const DOW_LONG  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const MON_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const SLIPPED_DIGIT_MULTIPLIER = 3;

export async function loadReviewScreen(
  sb: SupabaseClient,
  viewer: ViewerLite,
  site: SiteInfo,
  weekStart: string,
  email: string,
): Promise<ReviewView> {
  const accountKey = site.accountKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`loadReviewScreen: weekStart must be YYYY-MM-DD, got ${weekStart}`);
  }
  if (mondayOfWeek(weekStart) !== weekStart) {
    throw new Error(`loadReviewScreen: weekStart must be a Monday, got ${weekStart}`);
  }

  const span = await resolveFinalizeReviewSpan(accountKey, weekStart, sb);
  const unitStart = span.spanStart;
  const unitEnd = span.spanEnd;
  const unitDates = span.dates;
  const isBiweeklyUnit = span.isBiweekly && unitDates.length === 14;

  const [servicesQ, groupsQ, actQ, projQ, metaQ, finQ, siteTodayQ, revQ] = await Promise.all([
    sb.from("sc_services")
      .select("id, service_name, group_id, unit, is_flat_fee, is_non_revenue, sort_order")
      .eq("account_key", accountKey)
      .order("sort_order", { ascending: true }),
    sb.from("sc_service_groups")
      .select("id, group_name")
      .eq("account_key", accountKey),
    sb.from("sc_daily_actuals")
      .select("service_id, service_date, actual_count, updated_at")
      .eq("account_key", accountKey)
      .in("service_date", unitDates),
    sb.from("sc_daily_projections")
      .select("service_id, service_date, projected_count")
      .eq("account_key", accountKey)
      .in("service_date", unitDates),
    sb.from("sc_day_metadata")
      .select("service_date, review_status")
      .eq("account_key", accountKey)
      .in("service_date", unitDates),
    // Finalize row is keyed on the SUBMITTED Monday - for a biweekly
    // pair that is the CLOSING week's Monday (the page's weekStart
    // param, not span.spanStart). This is the write the submit route
    // makes too.
    sb.from("sc_week_finalize")
      .select("status, finalized_at")
      .eq("account_key", accountKey)
      .eq("week_start", weekStart)
      .neq("status", "reverted")
      .maybeSingle(),
    sb.rpc("sc_site_today", { p_account_key: accountKey }),
    // sc_daily_revenue is the one source for the invoice dollars.
    // actual_revenue carries the rounded per-line cents-as-dollars.
    // Reading here keeps the week check byte-aligned with what the
    // invoice builder produces.
    sb.from("sc_daily_revenue")
      .select("service_date, service_id, actual_revenue, is_non_revenue, has_actuals")
      .eq("account_key", accountKey)
      .in("service_date", unitDates),
  ]);

  if (servicesQ.error) throw new Error(`sc_services: ${servicesQ.error.message}`);
  if (groupsQ.error)   throw new Error(`sc_service_groups: ${groupsQ.error.message}`);
  if (actQ.error)      throw new Error(`sc_daily_actuals: ${actQ.error.message}`);
  if (projQ.error)     throw new Error(`sc_daily_projections: ${projQ.error.message}`);
  if (metaQ.error)     throw new Error(`sc_day_metadata: ${metaQ.error.message}`);
  if (finQ.error)      throw new Error(`sc_week_finalize: ${finQ.error.message}`);
  if (siteTodayQ.error) throw new Error(`sc_site_today: ${siteTodayQ.error.message}`);
  if (revQ.error)      throw new Error(`sc_daily_revenue: ${revQ.error.message}`);

  const services = (servicesQ.data ?? []) as SvcRow[];
  const groups = (groupsQ.data ?? []) as GroupRow[];
  const groupNameById = new Map<string, string>(groups.map((g) => [g.id, g.group_name]));

  // Prices for display only (dollars come from the view).
  const svcIds = services.map((s) => s.id);
  const pricesQ = svcIds.length === 0 ? { data: [], error: null } : await sb
    .from("sc_service_prices")
    .select("service_id, price, effective_date")
    .in("service_id", svcIds)
    .lte("effective_date", unitEnd)
    .order("effective_date", { ascending: false });
  if (pricesQ.error) throw new Error(`sc_service_prices: ${(pricesQ as { error: { message: string } }).error.message}`);
  const latestPriceByService = new Map<string, number | null>();
  for (const row of (pricesQ.data ?? []) as PriceRow[]) {
    if (!latestPriceByService.has(row.service_id)) {
      latestPriceByService.set(row.service_id, row.price);
    }
  }

  const svcById = new Map<string, SvcRow>(services.map((s) => [s.id, s]));
  const sortOrderById = new Map<string, number>(services.map((s) => [s.id, s.sort_order ?? 0]));
  const actByDate = groupBy((actQ.data ?? []) as ActualRow[], (r) => r.service_date);
  const projByDate = groupBy((projQ.data ?? []) as ProjRow[], (r) => r.service_date);
  const revByDate = groupBy((revQ.data ?? []) as RevRow[], (r) => r.service_date);
  const flaggedByDate = new Set<string>(
    ((metaQ.data ?? []) as MetaRow[])
      .filter((m) => m.review_status === "flagged")
      .map((m) => m.service_date),
  );
  const siteToday = String(siteTodayQ.data ?? unitEnd);

  const finalizeRow = finQ.data as { status: string; finalized_at: string } | null;
  const isAlreadySubmitted = !!finalizeRow;
  const submittedAt = finalizeRow?.finalized_at ?? null;

  let totalMeals = 0;
  let totalCents = 0;

  const days: ReviewDay[] = unitDates.map((iso) => {
    const dowIx = ((new Date(`${iso}T12:00:00Z`).getUTCDay()) + 6) % 7;
    const [, mm, dd] = iso.split("-").map(Number);
    const acts = actByDate.get(iso) ?? [];
    const projs = projByDate.get(iso) ?? [];
    const revs  = revByDate.get(iso) ?? [];
    const projById = new Map<string, number>(
      projs.filter((p) => (p.projected_count ?? 0) > 0).map((p) => [p.service_id, p.projected_count as number]),
    );
    const actById = new Map<string, ActualRow>(
      acts.map((a) => [a.service_id, a]),
    );
    const revById = new Map<string, RevRow>(
      revs.map((r) => [r.service_id, r]),
    );

    const lines: ReviewLine[] = [];
    let dayMeals = 0;
    let dayCents = 0;
    for (const [sid, actRow] of actById) {
      const count = actRow.actual_count ?? 0;
      if (count <= 0) continue;
      const svc = svcById.get(sid);
      if (!svc) continue;
      const priceDollars = latestPriceByService.get(sid) ?? null;
      const priceCents = priceDollars == null ? null : Math.round(priceDollars * 100);
      const viewRow = revById.get(sid);
      const viewCents = viewRow?.actual_revenue != null ? Math.round(viewRow.actual_revenue * 100) : null;
      const beforeTaxCents = svc.is_non_revenue ? null : viewCents;
      if (svc.unit === "meals" && !svc.is_flat_fee) dayMeals += count;
      if (beforeTaxCents != null) dayCents += beforeTaxCents;
      lines.push({
        serviceId: sid,
        serviceName: svc.service_name,
        groupName: svc.group_id ? (groupNameById.get(svc.group_id) ?? null) : null,
        isFlatFee: !!svc.is_flat_fee,
        isNonRevenue: !!svc.is_non_revenue,
        unit: (svc.unit || "meals") as ReviewLine["unit"],
        actualCount: count,
        priceCents,
        beforeTaxCents,
        isNotBilled: !!svc.is_non_revenue,
        sortOrder: sortOrderById.get(sid) ?? 0,
      });
    }
    lines.sort((a, b) => a.sortOrder - b.sortOrder);

    const notServedNames = Array.from(actById.entries())
      .filter(([, r]) => (r.actual_count ?? 0) === 0)
      .map(([sid]) => svcById.get(sid)?.service_name ?? "")
      .filter(Boolean);
    const blankProjectedNames = Array.from(projById.keys())
      .filter((sid) => !actById.has(sid))
      .map((sid) => svcById.get(sid)?.service_name ?? "")
      .filter(Boolean);

    const hasAnyActualAbove = lines.length > 0;
    const hasAnyActualZero  = notServedNames.length > 0;
    const hasProjectedAbove = projById.size > 0;

    const out = resolveDayState({
      hasAnyActualAbove,
      hasAnyActualZero,
      hasAnyProjectedAbove: hasProjectedAbove,
      blankProjectedCount: blankProjectedNames.length,
      reviewStatus: flaggedByDate.has(iso) ? "flagged" : null,
      // A submitted finalize row covers every day in the unit.
      isInSubmittedSpan: isAlreadySubmitted,
      // The review screen is reachable only while the period is open
      // from the leader's side. isPeriodClosed = false here.
      isPeriodClosed: false,
      unitEndedBeforeSiteToday: unitEnd < siteToday,
    });

    // Rule 5 look reasons.
    const lookReasons: ReviewLookReason[] = [];
    if (hasAnyActualAbove || hasAnyActualZero) {
      if (iso > siteToday) {
        lookReasons.push({ kind: "future", dayWord: DOW_LONG[dowIx] });
      } else {
        // Use the site's timezone to read the save-date from the
        // updated_at timestamp; a Chicago evening save on Nov 4 at
        // 22:30 CST is `2026-11-05T04:30Z` in UTC - slicing in UTC
        // would read it as Nov 5 and skip the "entered ahead" cue.
        const latestUpdate = latestUpdatedAtOnDay(acts);
        if (latestUpdate) {
          const saveDate = isoInSiteTz(latestUpdate, site.timezone);
          if (saveDate < iso) {
            lookReasons.push({ kind: "entered_ahead", onLabel: shortIsoLabel(saveDate) });
          }
        }
      }
      for (const ln of lines) {
        if (ln.isFlatFee) continue;
        const p = projById.get(ln.serviceId) ?? 0;
        if (p > 0 && ln.actualCount >= SLIPPED_DIGIT_MULTIPLIER * p) {
          lookReasons.push({
            kind: "slipped",
            serviceName: ln.serviceName,
            actual: ln.actualCount,
            projected: p,
          });
        }
      }
    }

    totalMeals += dayMeals;
    if (site.isBilled) totalCents += dayCents;

    return {
      iso,
      dowShort: DOW_SHORT[dowIx],
      dowLong: DOW_LONG[dowIx],
      dateLabel: `${MON_SHORT[mm - 1]} ${dd}`,
      stateCode: out.state,
      stateWord: out.word,
      dayMeals,
      dayCents: site.isBilled ? dayCents : null,
      lines,
      notServedNames,
      blankProjectedNames,
      isFlagged: flaggedByDate.has(iso),
      lookReasons,
    };
  });

  const preflight = isAlreadySubmitted
    ? []
    : await checkWeekSubmittable({ accountKey, weekStart, email }, sb);

  return {
    viewer,
    site,
    weekStart,
    unitStart,
    unitEnd,
    isBiweeklyUnit,
    isAlreadySubmitted,
    submittedAt,
    days,
    totalMeals,
    totalCents,
    isBilled: site.isBilled,
    preflight,
    siteToday,
  };
}

// Thin helper for the finish payload. One source of truth: it just
// reads the full view and returns the two numbers + the unit span.
export async function loadReviewTotals(
  sb: SupabaseClient,
  viewer: ViewerLite,
  site: SiteInfo,
  weekStart: string,
  email: string,
): Promise<ReviewTotals & { unitSpanDays: number; unitStart: string; unitEnd: string }> {
  const view = await loadReviewScreen(sb, viewer, site, weekStart, email);
  return {
    totalMeals: view.totalMeals,
    totalCents: view.totalCents,
    unitSpanDays: view.isBiweeklyUnit ? 14 : 7,
    unitStart: view.unitStart,
    unitEnd: view.unitEnd,
  };
}

function groupBy<T, K>(rows: T[], keyFn: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = keyFn(row);
    const arr = out.get(k);
    if (arr) arr.push(row); else out.set(k, [row]);
  }
  return out;
}

function latestUpdatedAtOnDay(acts: ActualRow[]): string | null {
  let latest: string | null = null;
  for (const a of acts) {
    if (!a.updated_at) continue;
    if (!latest || a.updated_at > latest) latest = a.updated_at;
  }
  return latest;
}

function shortIsoLabel(iso: string): string {
  const [, mm, dd] = iso.split("-").map(Number);
  return `${MON_SHORT[mm - 1]} ${dd}`;
}

// Format an ISO timestamp as a YYYY-MM-DD in the given IANA timezone.
// Falls back to a UTC slice when the timezone is null/empty, which
// is good enough for the America/Chicago-stable corp accounts while
// still being correct for the sites with a real tz column.
function isoInSiteTz(isoTs: string, timezone: string | null | undefined): string {
  if (!timezone) return isoTs.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(isoTs));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}
