// Day-actuals save route.
//
// POST   - upsert the touched entries for one (account, serviceDate).
// DELETE - clear the day back to projections (deletes every row).
//
// Gate order (both verbs):
//   1. requireOwnerApi()               -> 401 / 404 Response verbatim
//   2. canWriteForAccount(viewer, key) -> 403 NOT_AUTHORIZED
//   3. coerceActualCount every entry   -> 400 INVALID_COUNT      (POST only)
//   4. assertDaysUnlockedForWrite      -> 403 PERIOD_LOCKED
//   5. assertWeekOpenForWrite          -> 403 WEEK_FINALIZED
//   6. Concurrency token recheck       -> 409 DAY_CHANGED (acceptClash skips)
//   7. saveActuals / deleteDayActuals  -> write
//   8. clearReviewStateForDays         -> non-fatal; log + continue
//   9. Recompute day token + state     -> included in the 200 response
//
// The route is owner-only today (requireOwnerApi). Once staff sign-in
// opens, canWriteForAccount's `is_corp OR (is_salaried and own account)`
// rule is the gate; the owner check in the gate helper adds no cost.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { assertDaysUnlockedForWrite } from "@/lib/sc/scPeriodLock";
import { assertWeekOpenForWrite } from "@/lib/sc/scWeekFinalize";
import { clearReviewStateForDays } from "@/lib/sc/scReviewState";
import { canWriteForAccount } from "@/lib/sc/access/canWriteForAccount";
import { ActualCountValidationError, coerceActualCount } from "@/lib/sc/dayActuals/coerceActualCount";
import { saveActuals, deleteDayActuals } from "@/lib/sc/dayActuals/saveActuals";
import { isMarkedNotServed } from "@/lib/sc/dayActuals/notServedCheck";
import { buildDayToken } from "@/lib/sc/dayActuals/dayToken";
import { resolveDayState } from "@/lib/sc/calendar/dayState";
import type { ViewerLite } from "@/lib/sc/calendar/types";
import type { TheirRow } from "@/lib/sc/dayActuals/types";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface SaveBody {
  accountKey?: unknown;
  serviceDate?: unknown;
  entries?: unknown;
  dayToken?: unknown;
  acceptClash?: unknown;
}

interface DeleteBody {
  accountKey?: unknown;
  serviceDate?: unknown;
  dayToken?: unknown;
  acceptClash?: unknown;
}

// ─────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: SaveBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, { status: 400 });
  }

  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const serviceDate = typeof body.serviceDate === "string" ? body.serviceDate : null;
  const dayToken = typeof body.dayToken === "string" ? body.dayToken : null;
  const acceptClash = body.acceptClash === true;

  if (!accountKey) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "accountKey required" }, { status: 400 });
  if (!serviceDate || !ISO.test(serviceDate)) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "serviceDate must be YYYY-MM-DD" }, { status: 400 });
  if (!dayToken) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "dayToken required" }, { status: 400 });
  if (!Array.isArray(body.entries)) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "entries must be an array" }, { status: 400 });

  const sb = serviceClient();

  const scopeErr = await authorizeAccount(sb, email, accountKey);
  if (scopeErr) return scopeErr;

  // Validate every entry. Empty entries array is a legitimate no-op
  // (the UI's "no changes" path); skip the upsert but still rotate
  // the token so the client picks up the latest state.
  const touched: { serviceId: string; actualCount: number }[] = [];
  for (const raw of body.entries as unknown[]) {
    const r = raw as { serviceId?: unknown; actualCount?: unknown };
    const serviceId = typeof r.serviceId === "string" ? r.serviceId : null;
    if (!serviceId) return NextResponse.json({ ok: false, code: "INVALID_COUNT", serviceId: "", message: "serviceId required" }, { status: 400 });
    try {
      const n = coerceActualCount(r.actualCount, serviceId);
      touched.push({ serviceId, actualCount: n });
    } catch (err) {
      if (err instanceof ActualCountValidationError) {
        return NextResponse.json({ ok: false, code: "INVALID_COUNT", serviceId: err.serviceId, message: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const periodLock = await assertDaysUnlockedForWrite(accountKey, [serviceDate], email);
  if (periodLock) return NextResponse.json({ ok: false, ...periodLock }, { status: 403 });
  const weekLock = await assertWeekOpenForWrite(accountKey, [serviceDate], email);
  if (weekLock) return NextResponse.json({ ok: false, ...weekLock }, { status: 403 });

  const clash = await tokenMismatchResponse(sb, accountKey, serviceDate, dayToken, acceptClash);
  if (clash) return clash;

  // Fix 4: capture pre-save shape so the "Marked not served" note
  // fires only on the save that FLIPS a day to not-served. Needs
  // the projections set + the current actuals.
  const preShape = await loadNotServedShape(sb, accountKey, serviceDate);
  const wasAlreadyNotServed = isMarkedNotServed(preShape);

  if (touched.length > 0) {
    try { await saveActuals(sb, accountKey, serviceDate, touched, email); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: msg }, { status: 500 });
    }
  }

  // Review-state clear is non-fatal.
  try { await clearReviewStateForDays(accountKey, [serviceDate]); }
  catch (err) { console.error("[day-actuals POST] clearReviewStateForDays failed:", err); }

  // Fix 4: write the note only when (every projected line on this
  // day is at 0 AFTER the save) AND (that was not already true
  // before). Partial-zero shapes do not fire. A re-save of an
  // already-not-served day does not fire. Log-and-continue.
  if (touched.length > 0) {
    try {
      const postShape = await loadNotServedShape(sb, accountKey, serviceDate);
      const isNowNotServed = isMarkedNotServed(postShape);
      if (isNowNotServed && !wasAlreadyNotServed) {
        await writeSystemNote(sb, accountKey, serviceDate, "Marked not served", email);
      }
    } catch (err) {
      console.error("[day-actuals POST] system-note write failed:", err);
    }
  }

  return NextResponse.json(await buildOkResponse(sb, accountKey, serviceDate, touched.length));
}

async function loadNotServedShape(
  sb: SupabaseClient,
  accountKey: string,
  serviceDate: string,
): Promise<{ projectedServiceIds: Set<string>; actualCountByServiceId: Map<string, number> }> {
  const [projQ, actQ] = await Promise.all([
    sb.from("sc_daily_projections")
      .select("service_id, projected_count")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate),
    sb.from("sc_daily_actuals")
      .select("service_id, actual_count")
      .eq("account_key", accountKey)
      .eq("service_date", serviceDate),
  ]);
  if (projQ.error) throw new Error(`sc_daily_projections: ${projQ.error.message}`);
  if (actQ.error)  throw new Error(`sc_daily_actuals: ${actQ.error.message}`);
  const projectedServiceIds = new Set<string>();
  for (const r of (projQ.data ?? []) as Array<{ service_id: string; projected_count: number | null }>) {
    if ((r.projected_count ?? 0) > 0) projectedServiceIds.add(String(r.service_id));
  }
  const actualCountByServiceId = new Map<string, number>();
  for (const r of (actQ.data ?? []) as Array<{ service_id: string; actual_count: number | null }>) {
    actualCountByServiceId.set(String(r.service_id), Number(r.actual_count ?? 0));
  }
  return { projectedServiceIds, actualCountByServiceId };
}

// ─────────────────────────────────────────────────────────────────

export async function DELETE(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: DeleteBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, { status: 400 });
  }

  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const serviceDate = typeof body.serviceDate === "string" ? body.serviceDate : null;
  const dayToken = typeof body.dayToken === "string" ? body.dayToken : null;
  const acceptClash = body.acceptClash === true;

  if (!accountKey) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "accountKey required" }, { status: 400 });
  if (!serviceDate || !ISO.test(serviceDate)) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "serviceDate must be YYYY-MM-DD" }, { status: 400 });
  if (!dayToken) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "dayToken required" }, { status: 400 });

  const sb = serviceClient();

  const scopeErr = await authorizeAccount(sb, email, accountKey);
  if (scopeErr) return scopeErr;

  const periodLock = await assertDaysUnlockedForWrite(accountKey, [serviceDate], email);
  if (periodLock) return NextResponse.json({ ok: false, ...periodLock }, { status: 403 });
  const weekLock = await assertWeekOpenForWrite(accountKey, [serviceDate], email);
  if (weekLock) return NextResponse.json({ ok: false, ...weekLock }, { status: 403 });

  const clash = await tokenMismatchResponse(sb, accountKey, serviceDate, dayToken, acceptClash);
  if (clash) return clash;

  try { await deleteDayActuals(sb, accountKey, serviceDate); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: msg }, { status: 500 });
  }

  try { await clearReviewStateForDays(accountKey, [serviceDate]); }
  catch (err) { console.error("[day-actuals DELETE] clearReviewStateForDays failed:", err); }

  // Train 4: companion note on a successful "Back to projections".
  // Log-and-continue on failure; the DELETE already landed.
  try {
    await writeSystemNote(sb, accountKey, serviceDate, "Cleared back to projections", email);
  } catch (err) {
    console.error("[day-actuals DELETE] system-note write failed:", err);
  }

  return NextResponse.json(await buildOkResponse(sb, accountKey, serviceDate, 0));
}

// Insert one sc_day_note_entries row for a system-level event. The
// author is the signed-in session email, matching v1's sc-reset-day
// pattern; no "system" literal author so every entry carries the
// person who did it. The source column is null (sc-26 convention:
// null for authored or single-day audit notes, 'bulk' for batch).
async function writeSystemNote(
  sb: SupabaseClient,
  accountKey: string,
  serviceDate: string,
  note: string,
  author: string,
): Promise<void> {
  const { error } = await sb.from("sc_day_note_entries").insert({
    account_key: accountKey,
    service_date: serviceDate,
    note,
    author,
    source: null,
  });
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

async function authorizeAccount(sb: SupabaseClient, email: string, accountKey: string): Promise<Response | null> {
  const { viewer } = await resolveViewer(sb, email, null, true);
  if (!viewer) return NextResponse.json({ ok: false, code: "NOT_AUTHORIZED", message: "Viewer not on the roster." }, { status: 403 });
  const lite: ViewerLite = {
    worker_id: viewer.worker_id,
    display_name: viewer.display_name,
    role: viewer.role,
    is_corp: !!viewer.is_corp,
    is_regional_director: !!viewer.is_regional_director,
    is_salaried: !!viewer.is_salaried,
    region: viewer.region,
    account_key: viewer.account_key,
    previewOf: viewer.previewOf,
  };
  const check = canWriteForAccount(lite, accountKey);
  if (!check.ok) return NextResponse.json(check, { status: 403 });
  return null;
}

async function loadTokenRows(sb: SupabaseClient, accountKey: string, serviceDate: string) {
  const { data, error } = await sb
    .from("sc_daily_actuals")
    .select("service_id, actual_count, updated_at")
    .eq("account_key", accountKey)
    .eq("service_date", serviceDate);
  if (error) throw new Error(`sc_daily_actuals read: ${error.message}`);
  return (data ?? []) as { service_id: string; actual_count: number | null; updated_at: string | null }[];
}

async function tokenMismatchResponse(
  sb: SupabaseClient,
  accountKey: string,
  serviceDate: string,
  clientToken: string,
  acceptClash: boolean,
): Promise<Response | null> {
  if (acceptClash) return null;
  const rows = await loadTokenRows(sb, accountKey, serviceDate);
  const serverToken = buildDayToken(rows);
  if (serverToken === clientToken) return null;
  // Build the human-readable clash payload with service names.
  const serviceIds = rows.map((r) => r.service_id);
  const nameById = new Map<string, string>();
  if (serviceIds.length > 0) {
    const { data: svcs } = await sb
      .from("sc_services")
      .select("id, service_name")
      .in("id", serviceIds);
    for (const s of (svcs ?? []) as { id: string; service_name: string }[]) {
      nameById.set(s.id, s.service_name);
    }
  }
  // Pull updated_by too for the clash panel.
  const { data: withBy } = await sb
    .from("sc_daily_actuals")
    .select("service_id, actual_count, updated_at, updated_by")
    .eq("account_key", accountKey)
    .eq("service_date", serviceDate);
  const theirRows: TheirRow[] = ((withBy ?? []) as { service_id: string; actual_count: number | null; updated_at: string | null; updated_by: string | null }[]).map((r) => ({
    serviceId: r.service_id,
    serviceName: nameById.get(r.service_id) ?? r.service_id,
    actualCount: r.actual_count ?? 0,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }));
  return NextResponse.json({ ok: false, code: "DAY_CHANGED", theirRows, dayToken: serverToken }, { status: 409 });
}

async function buildOkResponse(sb: SupabaseClient, accountKey: string, serviceDate: string, written: number) {
  const rows = await loadTokenRows(sb, accountKey, serviceDate);
  const dayToken = buildDayToken(rows);

  // Feed the day's inputs to the SHARED pure resolver so the save
  // and the calendar can never disagree on the post-save word.
  // `isInSubmittedSpan` and `isPeriodClosed` are both false by
  // construction here: we just passed both lock gates.
  // `unitEndedBeforeSiteToday` is false too - "needs_actuals" is a
  // read-time call, not a post-save one; a day the owner just saved
  // is not in a past unit.
  const { data: proj } = await sb
    .from("sc_daily_projections")
    .select("service_id, projected_count")
    .eq("account_key", accountKey)
    .eq("service_date", serviceDate);
  const projectedAbove = new Set<string>(
    ((proj ?? []) as { service_id: string; projected_count: number | null }[])
      .filter((p) => (p.projected_count ?? 0) > 0)
      .map((p) => p.service_id),
  );
  const actualById = new Map<string, number | null>(rows.map((r) => [r.service_id, r.actual_count]));
  const blankProjectedCount = Array.from(projectedAbove).filter((id) => !actualById.has(id)).length;
  const hasAnyActualAbove = rows.some((r) => (r.actual_count ?? 0) > 0);
  const hasAnyActualZero = rows.some((r) => r.actual_count === 0);

  // `sc_day_metadata.review_status` is cleared post-save (non-fatal
  // path above). Treat it as null here so the word matches a reader
  // landing immediately after save.
  const out = resolveDayState({
    hasAnyActualAbove,
    hasAnyActualZero,
    hasAnyProjectedAbove: projectedAbove.size > 0,
    blankProjectedCount,
    reviewStatus: null,
    isInSubmittedSpan: false,
    isPeriodClosed: false,
    unitEndedBeforeSiteToday: false,
  });

  return { ok: true as const, written, dayToken, state: out.state, stateWord: out.word };
}
