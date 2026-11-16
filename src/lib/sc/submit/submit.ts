// sc-64 (Kevin ruling 2026-11-16): the lock.
//
// Runs checkWeekSubmittable. On an empty list, writes exactly one
// row into sc_week_finalize:
//   status           'finalized'
//   submitted_via    'v2'
//   push_attempts    0
//   push_next_try_at now(), at a billed site
//                    null,  at a site with no sc_qbo_account_map
//                    row (not billed from the calendar)
//   push_done_at     null,  at a billed site
//                    now(), at a non-billed site (done at once)
//
// Two people submitting the same week at once: the unique index on
// (account_key, week_start) where status <> 'reverted' refuses the
// second one with Postgres code 23505. We catch that and return
// `ALREADY_SUBMITTED`, not an error.

import { getServiceClient } from "@/lib/sc/_seams";
import { mondayOfWeek } from "@/lib/sc/scWeekFinalize";
import { checkWeekSubmittable } from "./checkSubmit";
import type {
  SupabaseClient,
  SubmitResult,
  SubmitBlock,
  FinalizeRowWithRetry,
} from "@/lib/sc/types";

export interface SubmitWeekArgs {
  accountKey: string;
  weekStart: string;
  email: string;
}

export async function submitWeek(
  args: SubmitWeekArgs,
  supaArg?: SupabaseClient,
): Promise<SubmitResult> {
  const supa = supaArg || getServiceClient();
  const { accountKey, weekStart, email } = args;
  // Same Monday guard as checkWeekSubmittable. Caller bug, not a
  // block. Throws here so no row is written on a malformed call
  // even if someone ever calls submitWeek without checkWeekSubmittable.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`submitWeek: weekStart must be YYYY-MM-DD, got ${JSON.stringify(weekStart)}`);
  }
  if (mondayOfWeek(weekStart) !== weekStart) {
    throw new Error(`submitWeek: weekStart must be a Monday, got ${weekStart}`);
  }

  const blocks: SubmitBlock[] = await checkWeekSubmittable(args, supa);
  if (blocks.length > 0) return { ok: false, blocks };

  // A site with no sc_qbo_account_map row is not billed from the
  // calendar. The row is written done at once: push_done_at set,
  // push_next_try_at NULL. The retry loop never picks it up.
  const { data: billed, error: billedErr } = await supa
    .from("sc_qbo_account_map")
    .select("account_key")
    .eq("account_key", accountKey)
    .maybeSingle();
  if (billedErr) {
    throw new Error(`submitWeek sc_qbo_account_map read: ${billedErr.message}`);
  }
  const isBilled = !!billed;

  // The app server's clock. Passed as an ISO string so the comparison
  // in the claim statement is textual on the same column type
  // (timestamptz accepts ISO strings).
  const now = new Date().toISOString();

  const insertRow: Record<string, unknown> = {
    account_key:      accountKey,
    week_start:       weekStart,
    status:           "finalized",
    finalized_by:     email,
    finalized_at:     now,
    submitted_via:    "v2",
    push_attempts:    0,
    push_next_try_at: isBilled ? now : null,
    push_done_at:     isBilled ? null : now,
    push_gave_up_at:  null,
    push_last_error:  null,
  };

  const { data: inserted, error: insErr } = await supa
    .from("sc_week_finalize")
    .insert(insertRow)
    .select("*")
    .single();

  if (insErr) {
    // 23505 = unique_violation. Treated as ALREADY_SUBMITTED, not an
    // error. Any other code bubbles.
    if (String(insErr.code) === "23505") {
      // Fetch the row that won the race so the caller can show its
      // submittedAt. The address is not in the block; the screen
      // looks it up from finalized_by when it needs to show a name.
      const { data: liveRow } = await supa
        .from("sc_week_finalize")
        .select("finalized_at")
        .eq("account_key", accountKey)
        .eq("week_start", weekStart)
        .neq("status", "reverted")
        .maybeSingle();
      return {
        ok: false,
        blocks: [
          {
            code: "ALREADY_SUBMITTED",
            detail: { submittedAt: String(liveRow?.finalized_at || "") },
          },
        ],
      };
    }
    throw new Error(`submitWeek insert: ${insErr.message}`);
  }

  return { ok: true, row: inserted as FinalizeRowWithRetry };
}
