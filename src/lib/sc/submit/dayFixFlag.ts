// dayFixFlag - the write core for /api/service/day-fix-flag.
//
// Pulled out so the behavior under test is a pure function with a
// Supabase client in / a discriminated result out. The route wires
// requireOwnerApi + canWriteForAccount; this file owns the lock
// gates, the update-only write, and the "day has no record" refusal
// that round 3 adds.
//
// Why update-only: sc_day_metadata is the day's record. v1 labor,
// v1 year view, the period lock, and sc_daily_revenue all read it.
// An insert from this path would create a row with no period and
// no week_label - the same shape of accident that forced the Nov
// 15 2026 2027-records reversal. If no row exists for the day, we
// refuse.

import type { SupabaseClient } from "@supabase/supabase-js";
import { assertDaysUnlockedForWrite } from "@/lib/sc/scPeriodLock";
import { assertWeekOpenForWrite } from "@/lib/sc/scWeekFinalize";
import { clearReviewStateForDays } from "@/lib/sc/scReviewState";

export type DayFixResult =
  | { ok: true; mode: "flagged" }
  | { ok: true; mode: "cleared"; cleared: number }
  | { ok: false; code: "PERIOD_LOCKED"; lockedDates: string[]; message: string }
  | { ok: false; code: "WEEK_FINALIZED"; finalizedWeeks: Array<{ weekStart: string; status: string }>; message: string }
  | { ok: false; code: "NO_DAY_RECORD"; message: string }
  | { ok: false; code: "WRITE_FAILED"; message: string };

export interface DayFixInput {
  accountKey: string;
  iso: string;
  email: string;
}

export async function flagDayForFix(sb: SupabaseClient, input: DayFixInput): Promise<DayFixResult> {
  const { accountKey, iso, email } = input;

  const periodLock = await assertDaysUnlockedForWrite(accountKey, [iso], email, sb);
  if (periodLock) return { ok: false, ...periodLock };
  const weekLock = await assertWeekOpenForWrite(accountKey, [iso], email, sb);
  if (weekLock) return { ok: false, ...weekLock };

  // UPDATE only. If zero rows match, refuse. Do NOT insert.
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await sb
    .from("sc_day_metadata")
    .update({
      review_status: "flagged",
      reviewed_by: email,
      reviewed_at: nowIso,
    })
    .eq("account_key", accountKey)
    .eq("service_date", iso)
    .select("service_date");
  if (error) return { ok: false, code: "WRITE_FAILED", message: error.message };
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      code: "NO_DAY_RECORD",
      message: "That day has no record yet. Enter it from the calendar, then mark it for a fix.",
    };
  }
  return { ok: true, mode: "flagged" };
}

export async function clearDayFix(sb: SupabaseClient, input: DayFixInput): Promise<DayFixResult> {
  const { accountKey, iso, email } = input;

  const periodLock = await assertDaysUnlockedForWrite(accountKey, [iso], email, sb);
  if (periodLock) return { ok: false, ...periodLock };
  const weekLock = await assertWeekOpenForWrite(accountKey, [iso], email, sb);
  if (weekLock) return { ok: false, ...weekLock };

  const out = await clearReviewStateForDays(accountKey, [iso], sb);
  if (!out.success) return { ok: false, code: "WRITE_FAILED", message: out.error ?? "clear failed" };
  return { ok: true, mode: "cleared", cleared: out.cleared ?? 0 };
}
