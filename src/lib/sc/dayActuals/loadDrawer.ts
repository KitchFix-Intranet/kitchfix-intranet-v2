// loadDayDrawer - assembles the DayDrawerView for a single day.
//
// One round trip budget: six parallel reads inside Promise.all. No
// per-service follow-ups.
//
//   1. sc_services for the site
//   2. sc_daily_projections for the day
//   3. sc_daily_actuals for the day
//   4. sc_day_metadata for the day
//   5. sc_qbo_service_map for the site (invoice-slot flag)
//   6. accounts row (for name + region)
//
// Lock state is computed from the engine helpers in parallel: the
// period lock and the week lock both refuse writes; the drawer renders
// read-only and the save route refuses the same way.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ViewerLite, SiteInfo } from "@/lib/sc/calendar/types";
import type { DayDrawerView, DrawerService, DrawerLock } from "./types";
import { buildDayToken } from "./dayToken";
import { assertDaysUnlockedForWrite } from "@/lib/sc/scPeriodLock";
import { assertWeekOpenForWrite } from "@/lib/sc/scWeekFinalize";

interface SvcCatalogRow {
  id: string;
  service_name: string;
  group_id: string | null;
  unit: string;
  is_flat_fee: boolean;
  is_non_revenue: boolean;
  active: boolean;
  active_until: string | null;
}

interface SvcGroupRow { id: string; group_name: string; }

interface ProjRow { service_id: string; projected_count: number | null; }

interface ActualRow {
  service_id: string;
  actual_count: number | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface MetaRow {
  event_label: string | null;
  game_type: string | null;
  game_time: string | null;
}

interface SvcMapRow {
  service_id: string;
  invoice_slot: string | null;
}

interface PriceRow {
  service_id: string;
  price: number | null;  // per the sc_service_prices table
  effective_date: string;
}

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dowIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Monday-Sunday bounds for a given ISO. dowIndex: Sun=0..Sat=6.
function weekBoundsIso(iso: string): { monday: string; sunday: string } {
  const dow = dowIndex(iso);
  // Convert to Monday-first offset (Mon=0..Sun=6)
  const offsetFromMonday = (dow + 6) % 7;
  const monday = addDaysIso(iso, -offsetFromMonday);
  const sunday = addDaysIso(monday, 6);
  return { monday, sunday };
}

export async function loadDayDrawer(
  sb: SupabaseClient,
  viewer: ViewerLite,
  site: SiteInfo,
  serviceDate: string,
): Promise<DayDrawerView> {
  const accountKey = site.accountKey;

  // Week bounds, used by the F2 "next day to enter" pass.
  const { monday, sunday } = weekBoundsIso(serviceDate);

  const [servicesQ, groupsQ, projQ, actQ, metaQ, svcMapQ, phaseQ, weekProjQ, weekActQ] = await Promise.all([
    sb.from("sc_services")
      .select("id, service_name, group_id, unit, is_flat_fee, is_non_revenue, active, active_until")
      .eq("account_key", accountKey)
      .order("sort_order", { ascending: true }),
    sb.from("sc_service_groups")
      .select("id, group_name")
      .eq("account_key", accountKey),
    sb.from("sc_daily_projections")
      .select("service_id, projected_count")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate),
    sb.from("sc_daily_actuals")
      .select("service_id, actual_count, updated_at, updated_by")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate),
    sb.from("sc_day_metadata")
      .select("event_label, game_type, game_time")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate)
      .maybeSingle(),
    sb.from("sc_qbo_service_map")
      .select("service_id, invoice_slot")
      .eq("account_key", accountKey),
    sb.from("sc_phase_calendar")
      .select("phase, start_date, end_date")
      .eq("account_key", accountKey)
      .lte("start_date", serviceDate)
      .gte("end_date", serviceDate)
      .maybeSingle(),
    // F2 next-day-to-enter: the week's projections for every day + the
    // week's actuals. Scoped to Mon-Sun so the server hands the drawer
    // the next weekday in the same week that still has projections not
    // fully answered. Not a full loadCalendar; narrow select bounded
    // by seven dates.
    sb.from("sc_daily_projections")
      .select("service_date, service_id, projected_count")
      .eq("account_key", accountKey)
      .gte("service_date", monday)
      .lte("service_date", sunday),
    sb.from("sc_daily_actuals")
      .select("service_date, service_id, actual_count")
      .eq("account_key", accountKey)
      .gte("service_date", monday)
      .lte("service_date", sunday),
  ]);

  // Prices: sc_service_prices is keyed by service_id, not account_key.
  // Pull the effective rows for just this site's services as of the
  // service date, in a second round-trip after we know the service ids.
  const serviceIds = (servicesQ.data ?? []).map((s: SvcCatalogRow) => s.id);
  const priceQ = serviceIds.length > 0
    ? await sb.from("sc_service_prices")
        .select("service_id, price, effective_date")
        .in("service_id", serviceIds)
        .lte("effective_date", serviceDate)
        .order("effective_date", { ascending: false })
    : { data: [], error: null };

  if (servicesQ.error) throw new Error(`sc_services: ${servicesQ.error.message}`);
  if (groupsQ.error) throw new Error(`sc_service_groups: ${groupsQ.error.message}`);
  if (projQ.error) throw new Error(`sc_daily_projections: ${projQ.error.message}`);
  if (actQ.error) throw new Error(`sc_daily_actuals: ${actQ.error.message}`);
  if (metaQ.error) throw new Error(`sc_day_metadata: ${metaQ.error.message}`);
  if (svcMapQ.error) throw new Error(`sc_qbo_service_map: ${svcMapQ.error.message}`);
  if (phaseQ.error) throw new Error(`sc_phase_calendar: ${phaseQ.error.message}`);
  if (weekProjQ.error) throw new Error(`sc_daily_projections (week): ${weekProjQ.error.message}`);
  if (weekActQ.error) throw new Error(`sc_daily_actuals (week): ${weekActQ.error.message}`);
  if (priceQ.error) throw new Error(`sc_service_prices: ${priceQ.error.message}`);

  const groupNameById = new Map<string, string>(
    (groupsQ.data ?? []).map((g: SvcGroupRow) => [g.id, g.group_name]),
  );
  const projById = new Map<string, number>(
    (projQ.data ?? [])
      .filter((p: ProjRow) => p.projected_count !== null && p.projected_count > 0)
      .map((p: ProjRow) => [p.service_id, p.projected_count as number]),
  );
  const actById = new Map<string, ActualRow>(
    (actQ.data ?? []).map((a: ActualRow) => [a.service_id, a]),
  );
  const slotByService = new Set<string>(
    (svcMapQ.data ?? [])
      .filter((r: SvcMapRow) => !!r.invoice_slot)
      .map((r: SvcMapRow) => r.service_id),
  );
  const latestPriceByService = new Map<string, number | null>();
  for (const row of (priceQ.data ?? []) as PriceRow[]) {
    if (!latestPriceByService.has(row.service_id)) {
      latestPriceByService.set(row.service_id, row.price);
    }
  }

  const services: DrawerService[] = (servicesQ.data ?? []).map((s: SvcCatalogRow) => {
    const act = actById.get(s.id);
    const projected = projById.has(s.id);
    const priceDollars = latestPriceByService.get(s.id) ?? null;
    return {
      serviceId: s.id,
      serviceName: s.service_name,
      groupName: s.group_id ? (groupNameById.get(s.group_id) ?? null) : null,
      unit: ((s.unit || "meals") as DrawerService["unit"]),
      isFlatFee: !!s.is_flat_fee,
      isNonRevenue: !!s.is_non_revenue,
      priceCents: priceDollars == null ? null : Math.round(priceDollars * 100),
      isProjected: projected,
      projectedCount: projById.get(s.id) ?? null,
      actualCount: act?.actual_count ?? null,
      hasActualsRow: !!act,
      hasInvoiceSlot: slotByService.has(s.id),
      isOnProjections: projected,
    };
  }).filter((s: DrawerService) => {
    // Every row currently in the drawer: all projected + any that
    // already have actuals saved. Services never-projected-never-saved
    // live in the "Add a service" picker only.
    return s.isProjected || s.hasActualsRow;
  });

  // Lock state: run both helpers. Either refusal makes the drawer
  // read-only; the save route will refuse too with the same code.
  let lock: DrawerLock | null = null;
  const periodLock = await assertDaysUnlockedForWrite(accountKey, [serviceDate], viewer.worker_id ? null : null);
  // ^ pass null for email here so the override does NOT apply at
  //   drawer open time. The save route will pass the owner email
  //   for the real override check.
  if (periodLock) {
    lock = { code: "PERIOD_LOCKED", message: periodLock.message };
  } else {
    const weekLock = await assertWeekOpenForWrite(accountKey, [serviceDate], null);
    if (weekLock) lock = { code: "WEEK_FINALIZED", message: weekLock.message };
  }

  // Day token - built from the raw actuals rows (service_id,
  // actual_count, updated_at). Open and save use the same shape so
  // a byte-identical state yields a byte-identical token.
  const dayToken = buildDayToken(
    ((actQ.data ?? []) as ActualRow[]).map((a) => ({
      service_id: a.service_id,
      actual_count: a.actual_count,
      updated_at: a.updated_at,
    })),
  );

  const meta: MetaRow = (metaQ.data as MetaRow) ?? { event_label: null, game_type: null, game_time: null };

  // Day state text + word for the chip - lightweight computation here.
  const hasActualAbove = Array.from(actById.values()).some((a) => (a.actual_count ?? 0) > 0);
  const hasActualZero = Array.from(actById.values()).some((a) => (a.actual_count ?? -1) === 0);
  const hasProjectedAbove = projById.size > 0;
  const blankProjected = Array.from(projById.keys()).filter((id) => !actById.has(id));
  let stateCode = "no_service";
  let stateWord = "No service";
  if (hasActualAbove && blankProjected.length === 0) { stateCode = "entered"; stateWord = "Entered"; }
  else if (hasActualAbove && blankProjected.length > 0) { stateCode = "part_entered"; stateWord = "Part entered"; }
  else if (!hasActualAbove && hasActualZero && hasProjectedAbove) { stateCode = "not_served"; stateWord = "Not served"; }
  else if (hasProjectedAbove) { stateCode = "projected"; stateWord = "Projected"; }

  const dowIx = dowIndex(serviceDate);
  const [yyyy, mm, dd] = serviceDate.split("-").map(Number);

  // F2 post-save focus: the next day in the same week that still has
  // projections and is not fully answered. We walk forward (skipping
  // the current day) and return the first iso that qualifies.
  const weekProjByDate = new Map<string, Set<string>>();
  for (const row of (weekProjQ.data ?? []) as { service_date: string; service_id: string; projected_count: number | null }[]) {
    if ((row.projected_count ?? 0) <= 0) continue;
    const set = weekProjByDate.get(row.service_date) ?? new Set<string>();
    set.add(row.service_id);
    weekProjByDate.set(row.service_date, set);
  }
  const weekActByDate = new Map<string, Set<string>>();
  for (const row of (weekActQ.data ?? []) as { service_date: string; service_id: string; actual_count: number | null }[]) {
    const set = weekActByDate.get(row.service_date) ?? new Set<string>();
    set.add(row.service_id);
    weekActByDate.set(row.service_date, set);
  }
  let nextDayToEnterIso: string | null = null;
  for (let i = 1; i <= 6; i++) {
    const iso = addDaysIso(serviceDate, i);
    if (iso > sunday) break;
    const proj = weekProjByDate.get(iso);
    if (!proj || proj.size === 0) continue;
    const act = weekActByDate.get(iso) ?? new Set<string>();
    // "Needs entry": at least one projected service for the day has
    // no actuals row yet. Fully answered day gets skipped.
    let needs = false;
    for (const sid of proj) {
      if (!act.has(sid)) { needs = true; break; }
    }
    if (needs) { nextDayToEnterIso = iso; break; }
  }

  return {
    viewer,
    site,
    serviceDate,
    dayOfWeekLong: DOW_LONG[dowIx],
    dayDisplayDate: `${MON_SHORT[mm - 1]} ${dd}, ${yyyy}`,
    rows: services,
    services: (servicesQ.data ?? []).map((s: SvcCatalogRow) => ({
      serviceId: s.id,
      serviceName: s.service_name,
      groupName: s.group_id ? (groupNameById.get(s.group_id) ?? null) : null,
      unit: ((s.unit || "meals") as DrawerService["unit"]),
      isFlatFee: !!s.is_flat_fee,
      isNonRevenue: !!s.is_non_revenue,
      priceCents: latestPriceByService.has(s.id) ? Math.round((latestPriceByService.get(s.id) as number) * 100) : null,
      isProjected: projById.has(s.id),
      projectedCount: projById.get(s.id) ?? null,
      actualCount: actById.get(s.id)?.actual_count ?? null,
      hasActualsRow: actById.has(s.id),
      hasInvoiceSlot: slotByService.has(s.id),
      isOnProjections: projById.has(s.id),
    })),
    lock,
    eventLabel: meta.event_label,
    gameType: meta.game_type === "DAY" || meta.game_type === "NIGHT" ? meta.game_type : null,
    gameTime: meta.game_time ?? null,
    phase: (phaseQ.data as { phase: string } | null)?.phase ?? null,
    dayToken,
    state: stateCode,
    stateWord,
    prevIso: addDaysIso(serviceDate, -1),
    nextIso: addDaysIso(serviceDate, 1),
    nextDayToEnterIso,
  };
}
