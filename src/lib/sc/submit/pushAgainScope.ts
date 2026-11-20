// Scope: who may press "Push to QuickBooks again" on the week check.
//
// Kevin ruling 2026-11-20 (train 4): the three people with
// is_sc_lock_override = true on any ACTIVE people row, lower-cased
// and trimmed. Same posture as isScLockOverrideDb in src/lib/sc/admin.ts:
//   - .limit(1) + any-row check, not .maybeSingle() (nine work
//     emails hold more than one active people row; .maybeSingle()
//     would error).
//   - .eq on lower-cased trimmed address; ilike would broaden the
//     match on `_` / `%` inside an email.
//   - any failure is a no (log, never throw).
//
// Also env-gated: with SC_V2_OUTBOUND = off the predicate is a flat
// false, so the button never shows and the route refuses.

import type { SupabaseClient } from "@supabase/supabase-js";
import { outboundMode } from "@/lib/sc/outboundGate";

export async function canPushAgainDb(
  sb: SupabaseClient,
  email: string | null,
): Promise<boolean> {
  if (outboundMode() === "off") return false;
  if (!email) return false;
  const e = email.toLowerCase().trim();
  if (!e) return false;
  try {
    const { data, error } = await sb.from("people")
      .select("worker_id")
      .eq("work_email", e)
      .eq("is_sc_lock_override", true)
      .eq("status", "ACTIVE")
      .limit(1);
    if (error) {
      console.error(`[pushAgainScope] people lookup failed`);
      return false;
    }
    return !!(data && data.length > 0);
  } catch (e2) {
    console.error(`[pushAgainScope] threw: ${e2 instanceof Error ? e2.message : String(e2)}`);
    return false;
  }
}
