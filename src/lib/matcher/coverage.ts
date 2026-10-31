// Live coverage figure used by the matcher cron's dollar cap. Computes
// total, covered (confirmed + proposed) and unlinked (none) directly
// from pr_vendor_items in a single paginated pass over the same filter
// set, so numerator and denominator always describe the same
// population. Never subtracts one filter from another: link_status is
// not an exhaustive partition (rows carry 'rejected', 'needs_review',
// etc.) and status='duplicate' / 'archived' rows exist that must not
// count toward either side.
//
// The denominator deliberately scopes to status='active' only, not
// ('active','resale'): the cron proposes vendor-items for review, and
// resale items are already settled on a different track. Keeps the
// bookkeeping clean - total, covered and none always sum coherently
// over the same rows.
//
// 8,039 active food rows at the Supabase 1000-row cap = 9 round trips,
// ~400ms before the cap decision - negligible beside the 90s matcher
// run that follows, and the whole check is skipped when owner-authed.

import type { SupabaseClient } from "@supabase/supabase-js";

export const MATCH_DOLLAR_TARGET_PCT = 80;

export type Coverage = {
  totalUsd: number;
  noneUsd: number;
  coveredUsd: number;
  pct: number;
  capMet: boolean;
};

export async function getMatcherCoverage(client: SupabaseClient): Promise<Coverage> {
  const PAGE = 1000;
  let from = 0;
  let totalUsd = 0;
  let coveredUsd = 0;
  let noneUsd = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select("usd_12m,link_status")
      .eq("is_food", true)
      .eq("status", "active")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { usd_12m: number | null; link_status: string | null }[];
    for (const r of rows) {
      const v = Number(r.usd_12m ?? 0);
      totalUsd += v;
      if (r.link_status === "confirmed" || r.link_status === "proposed") coveredUsd += v;
      else if (r.link_status === "none") noneUsd += v;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const pct = totalUsd > 0 ? (coveredUsd / totalUsd) * 100 : 0;
  return {
    totalUsd,
    noneUsd,
    coveredUsd,
    pct,
    capMet: pct >= MATCH_DOLLAR_TARGET_PCT,
  };
}
