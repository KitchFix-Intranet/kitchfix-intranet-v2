// sc-64 (Kevin ruling 2026-11-16): the checks before a lock.
//
// One function runs every check in order and returns every reason
// the week cannot be submitted. An empty array means submitWeek
// may write. The caller shows each block to the operator in plain
// words.
//
// Order of evaluation:
//   1. NOT_AUTHORIZED
//   2. ALREADY_SUBMITTED
//   3. WEEK_IN_FUTURE
//   4. NOT_CLOSING_WEEK    (biweekly only; first-week submit refused)
//   5. WEEK_LABEL_MISSING  (biweekly only; monday has no week_label)
//   6. PERIOD_LOCKED
//   7. DAY_FLAGGED
//   8. PROJECTION_UNENTERED
//   9. UNPRICED_LINES      (billed sites only)
//
// Checks 6-9 run over the span resolveFinalizeReviewSpan hands
// back: 7 days at a weekly site, 14 days at a biweekly close-week.
// A biweekly first-week submit (weekIndex 1 or 3) is refused at
// step 4 before any day-wide check runs.

import { getServiceClient } from "@/lib/sc/_seams";
import { canSubmitForAccount } from "./canSubmit";
import { assertDaysUnlockedForWrite } from "@/lib/sc/scPeriodLock";
import { resolveFinalizeReviewSpan, mondayOfWeek } from "@/lib/sc/scWeekFinalize";
import {
  findUnpricedBillableLines,
  type UnpricedLine,
} from "@/lib/sc/billing/buildInvoicePayload";
import type {
  SupabaseClient,
  SubmitBlock,
  ServiceMapRow,
  DailyRevenueRow,
} from "@/lib/sc/types";

export interface CheckWeekSubmittableArgs {
  accountKey: string;
  weekStart: string;
  email: string;
}

const REVENUE_COLS =
  "service_date, service_id, service_name, account_key, is_flat_fee, is_tax_free, is_non_revenue, actual_count, actual_price_at_date, price_at_date, projected_count, period, week_label, has_actuals, has_projection";

export async function checkWeekSubmittable(
  args: CheckWeekSubmittableArgs,
  supaArg?: SupabaseClient,
): Promise<SubmitBlock[]> {
  const supa = supaArg || getServiceClient();
  const { accountKey, weekStart, email } = args;
  // weekStart must be the Monday of its ISO week. A non-Monday
  // weekStart would make the span start on the wrong day, confuse the
  // unique index (which keys on the Monday), and let two live rows
  // for the same real week coexist. Caller bug, not a reason to show
  // a site, so this throws instead of returning a tenth block code.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`checkWeekSubmittable: weekStart must be YYYY-MM-DD, got ${JSON.stringify(weekStart)}`);
  }
  if (mondayOfWeek(weekStart) !== weekStart) {
    throw new Error(`checkWeekSubmittable: weekStart must be a Monday, got ${weekStart}`);
  }
  const blocks: SubmitBlock[] = [];

  // 1. NOT_AUTHORIZED - canSubmitForAccount has its own "never throws"
  // discipline so a read failure here reports as "not authorized",
  // which is the right conservative answer.
  const access = await canSubmitForAccount(email, accountKey, supa);
  if (!access.allowed) {
    blocks.push({
      code: "NOT_AUTHORIZED",
      detail: { reason: "You are not on the list of people who may submit for this site." },
    });
    // Stop here. If the person may not submit, the other blocks are
    // not theirs to see.
    return blocks;
  }

  // 2. ALREADY_SUBMITTED - a live (non-reverted) row on the account+week.
  const { data: liveRow, error: liveErr } = await supa
    .from("sc_week_finalize")
    .select("finalized_at, status")
    .eq("account_key", accountKey)
    .eq("week_start", weekStart)
    .neq("status", "reverted")
    .maybeSingle();
  if (liveErr) {
    throw new Error(`checkWeekSubmittable live-row read: ${liveErr.message}`);
  }
  if (liveRow) {
    // No address in the block. The screen will look the submitter up
    // from finalized_by when it needs to show a name.
    blocks.push({
      code: "ALREADY_SUBMITTED",
      detail: { submittedAt: String(liveRow.finalized_at || "") },
    });
  }

  // 3. WEEK_IN_FUTURE - weekStart is after the site's own today.
  // sc_site_today returns a date (YYYY-MM-DD).
  const { data: siteTodayData, error: siteErr } = await supa.rpc("sc_site_today", { p_account_key: accountKey });
  if (siteErr) {
    throw new Error(`checkWeekSubmittable sc_site_today: ${siteErr.message}`);
  }
  const siteToday = String(siteTodayData || "").slice(0, 10);
  if (siteToday && weekStart > siteToday) {
    blocks.push({ code: "WEEK_IN_FUTURE", detail: { weekStart, siteToday } });
  }

  // 4 / 5. Resolve the review span. For a weekly site this is 7 days;
  // for a biweekly close-week it is 14 days (first week + close week).
  // A biweekly first-week submit returns weekIndex 1 or 3 and gets
  // NOT_CLOSING_WEEK; a biweekly row with no week_label on the Monday
  // returns weekIndex null and gets WEEK_LABEL_MISSING.
  const span = await resolveFinalizeReviewSpan(accountKey, weekStart, supa);
  if (span.isBiweekly) {
    if (span.weekIndex === 1 || span.weekIndex === 3) {
      const closingWeekStart = /* next Monday */ addDaysIso(weekStart, 7);
      blocks.push({ code: "NOT_CLOSING_WEEK", detail: { closingWeekStart } });
      // Early exit: a first-week submit is not legal; running the
      // day-wide checks on half a pair would be misleading.
      return blocks;
    }
    if (span.weekIndex == null) {
      blocks.push({ code: "WEEK_LABEL_MISSING", detail: { weekStart } });
      return blocks;
    }
  }

  // 6. PERIOD_LOCKED - assertDaysUnlockedForWrite wraps sc_is_day_locked
  // and honours is_sc_lock_override. Returns null when all clear or
  // { code: "PERIOD_LOCKED", lockedDates, message } when blocked.
  const lockResult = await assertDaysUnlockedForWrite(accountKey, span.dates, email, supa);
  if (lockResult && lockResult.code === "PERIOD_LOCKED") {
    blocks.push({
      code: "PERIOD_LOCKED",
      detail: { lockedDates: lockResult.lockedDates },
    });
  }

  // 7. DAY_FLAGGED - any day in the span whose review_status is
  // 'flagged'. "Needs a fix" per the brief.
  const { data: flaggedRows, error: flagErr } = await supa
    .from("sc_day_metadata")
    .select("service_date")
    .eq("account_key", accountKey)
    .in("service_date", span.dates)
    .eq("review_status", "flagged");
  if (flagErr) {
    throw new Error(`checkWeekSubmittable flagged read: ${flagErr.message}`);
  }
  if (flaggedRows && flaggedRows.length > 0) {
    blocks.push({
      code: "DAY_FLAGGED",
      detail: {
        flaggedDates: flaggedRows
          .map((r: { service_date: string }) => String(r.service_date).slice(0, 10))
          .sort(),
      },
    });
  }

  // Read sc_daily_revenue once for the span; checks 8 and 9 both
  // consume it. A projected row with no actuals is "projected_count > 0
  // and NOT has_actuals". A typed 0 means has_actuals is true and
  // passes.
  const { data: rowsRaw, error: rvErr } = await supa
    .from("sc_daily_revenue")
    .select(REVENUE_COLS)
    .eq("account_key", accountKey)
    .gte("service_date", span.spanStart)
    .lte("service_date", span.spanEnd);
  if (rvErr) {
    throw new Error(`checkWeekSubmittable sc_daily_revenue read: ${rvErr.message}`);
  }
  const rows: DailyRevenueRow[] = rowsRaw || [];

  // 8. PROJECTION_UNENTERED.
  const unentered: Array<{ service_id: string; service_name: string; service_date: string }> = [];
  for (const r of rows) {
    const projected = Number(r.projected_count);
    if (!isFinite(projected) || projected <= 0) continue;
    if (r.has_actuals) continue;
    unentered.push({
      service_id: r.service_id,
      service_name: r.service_name,
      service_date: String(r.service_date).slice(0, 10),
    });
  }
  if (unentered.length > 0) {
    blocks.push({ code: "PROJECTION_UNENTERED", detail: { lines: unentered } });
  }

  // 9. UNPRICED_LINES - billed sites only. A site with no
  // sc_qbo_account_map row is not billed from the calendar and skips
  // the check.
  const { data: billed, error: billedErr } = await supa
    .from("sc_qbo_account_map")
    .select("account_key")
    .eq("account_key", accountKey)
    .maybeSingle();
  if (billedErr) {
    throw new Error(`checkWeekSubmittable sc_qbo_account_map read: ${billedErr.message}`);
  }
  if (billed) {
    const { data: serviceMapRaw, error: smErr } = await supa
      .from("sc_qbo_service_map")
      .select("*")
      .eq("account_key", accountKey)
      .eq("active", true);
    if (smErr) {
      throw new Error(`checkWeekSubmittable sc_qbo_service_map read: ${smErr.message}`);
    }
    const serviceMap: ServiceMapRow[] = serviceMapRaw || [];
    const unpriced: UnpricedLine[] = findUnpricedBillableLines(rows, serviceMap);
    if (unpriced.length > 0) {
      blocks.push({ code: "UNPRICED_LINES", detail: { lines: unpriced } });
    }
  }

  return blocks;
}

// Small ISO-date helper duplicated here to avoid pulling scWeekFinalize's
// internal helpers across module boundaries. One line, no edge cases.
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
