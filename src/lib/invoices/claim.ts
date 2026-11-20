// Invoices V2 - per-row claim helper.
//
// Correction 1: supabase-js cannot run FOR UPDATE SKIP LOCKED,
// and this train adds no database function, so the retry picks
// rows one at a time:
//   1. select up to N candidate ids (held, due, not already
//      claimed);
//   2. for each, a conditional UPDATE … .select():
//        set claimed_until = now + 5 min
//        where id = X
//          and email_status = 'held'
//          and (claimed_until is null or claimed_until < now)
//      you own the row only if the UPDATE returns it.
//
// The send route uses the same conditional UPDATE after the
// commit function creates the send row (correction 2): the cron
// job races against the send call for the same row; the first
// one to win the UPDATE delivers, the other gets held.
//
// This file keeps the pure "may I claim this row" rule in
// canClaim so the race rule is tested on its own. The runtime
// helpers tryClaim / releaseClaim / candidateIdsForRetry live
// here too but are not pure - they touch Supabase.

import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_HOLD_MS = 5 * 60 * 1000;

export interface ClaimableRow {
  email_status: "held" | "sent" | "gave_up";
  claimed_until: string | null; // ISO timestamp or null
}

// Pure. The claim UPDATE's own WHERE clause has this same shape.
// Tested directly; the race rule lives here.
export function canClaim(row: ClaimableRow, now: Date): boolean {
  if (row.email_status !== "held") return false;
  if (row.claimed_until === null) return true;
  const until = Date.parse(row.claimed_until);
  if (!Number.isFinite(until)) return false;
  return until < now.getTime();
}

// Runtime: try to claim one row by id. Returns true only when
// the conditional UPDATE returned the row, meaning we and no one
// else held the claim at that moment.
export async function tryClaim(
  sb: SupabaseClient,
  sendId: string,
  now: Date = new Date(),
  holdMs: number = CLAIM_HOLD_MS,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const holdUntil = new Date(now.getTime() + holdMs).toISOString();
  const { data, error } = await sb
    .from("invoice_sends")
    .update({ claimed_until: holdUntil, updated_at: nowIso })
    .eq("id", sendId)
    .eq("email_status", "held")
    .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
    .select("id");
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

// Runtime: drop the claim after a delivery attempt. We leave
// email_status / email_next_attempt_at in whatever state deliver
// set.
export async function releaseClaim(sb: SupabaseClient, sendId: string): Promise<void> {
  await sb
    .from("invoice_sends")
    .update({ claimed_until: null, updated_at: new Date().toISOString() })
    .eq("id", sendId);
}

// Runtime: candidate ids for the retry route. The claim race
// still has to run per row; this is just the shortlist.
export async function candidateIdsForRetry(
  sb: SupabaseClient,
  now: Date = new Date(),
  limit: number = 5,
): Promise<string[]> {
  const nowIso = now.toISOString();
  const { data } = await sb
    .from("invoice_sends")
    .select("id")
    .eq("email_status", "held")
    .lte("email_next_attempt_at", nowIso)
    .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
    .order("email_next_attempt_at", { ascending: true })
    .limit(limit);
  return (data ?? []).map((r: { id: string }) => r.id);
}
