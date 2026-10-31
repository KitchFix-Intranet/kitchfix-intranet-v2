// Live coverage figure used by the matcher cron's dollar cap. Reads
// pr_v_overview_totals.food_dollars_total for the denominator and sums
// `usd_12m` over `link_status = 'none'` directly for the numerator -
// the view carries `food_items_waiting_usd` (none + proposed), which
// is the wrong split for us: 'proposed' already counts as covered
// here (Kevin has it in his queue, the matcher doesn't need to touch
// it again). Covered = total - none.
//
// Pagination follows the standard Supabase 1000-row cap. On the
// current queue (8K items) this is 8 round trips, ~400ms before the
// cap decision - negligible beside the 90s matcher run that follows,
// and zero when the cap is already met.

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
  const [{ data: totalsData, error: totalsErr }, noneUsd] = await Promise.all([
    client.from("pr_v_overview_totals").select("food_dollars_total").single(),
    sumNoneUsd(client),
  ]);
  if (totalsErr) throw totalsErr;
  const totalUsd = Number((totalsData as { food_dollars_total?: number } | null)?.food_dollars_total ?? 0);
  const coveredUsd = Math.max(0, totalUsd - noneUsd);
  const pct = totalUsd > 0 ? (coveredUsd / totalUsd) * 100 : 0;
  return {
    totalUsd,
    noneUsd,
    coveredUsd,
    pct,
    capMet: pct >= MATCH_DOLLAR_TARGET_PCT,
  };
}

async function sumNoneUsd(client: SupabaseClient): Promise<number> {
  const PAGE = 1000;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select("usd_12m")
      .eq("is_food", true)
      .in("status", ["active", "resale"])
      .eq("link_status", "none")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { usd_12m: number | null }[];
    for (const r of rows) total += Number(r.usd_12m ?? 0);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return total;
}
