// src/lib/kpi/portfolioMembers.js
//
// Single source of truth for pseudo-key membership (ALL / EAST / WEST).
//
// The read route (src/app/api/kpi/labor/route.js) and the export route
// (src/app/api/kpi/labor/export/route.js) both need to resolve which
// accounts sit inside a portfolio view. If the two diverged, an export
// scoped to EAST would show a different account set than the board it
// was exported from - worse than no export. Owner ruling 2026-08-24:
// do not re-derive membership; both routes call this helper.
//
// Rules:
// - ALL     = every non-CORP account in `accounts`
// - EAST    = accounts.region == 'East', minus CORP
// - WEST    = accounts.region == 'West', minus CORP
// - Rows are returned in team_key order (deterministic export filenames
//   and Summary sort).

import { pagedSelect } from "@/lib/kpi/shared/pagedSelect";

export const PORTFOLIO_KEYS = new Set(["ALL", "EAST", "WEST"]);

/**
 * Resolve members for a portfolio pseudo-key.
 *
 * @param {ReturnType<typeof import("@/lib/supabase").getServiceClient>} supa
 * @param {"ALL"|"EAST"|"WEST"} pseudoKey
 * @returns {Promise<{ data: Array<{team_key: string, region: string|null}>, error: any }>}
 */
export async function resolvePortfolioMembers(supa: any, pseudoKey: any) {
  if (!PORTFOLIO_KEYS.has(pseudoKey)) {
    return { data: [], error: { message: `not_a_portfolio_key: ${pseudoKey}` } };
  }
  // Kevin ruling 2026-10-06: retired accounts (accounts.active=false,
  // today CHI - IL + CIN - FL) are not portfolio members. .neq (not
  // .eq true) matches the SC + Academy pattern - NULL treats as
  // active so a new account inserted without the flag set does not
  // silently disappear from the dashboard.
  //
  // Train 2c: paged via pagedSelect. team_key is the accounts PK so
  // the sort is unique.
  const regionValue = pseudoKey === "ALL"
    ? null
    : (pseudoKey === "EAST" ? "East" : "West");
  const r = await pagedSelect((from: number, to: number) => {
    let q: any = supa.from("accounts")
      .select("team_key, region")
      .neq("team_key", "CORP")
      .neq("active", false)
      .order("team_key")
      .range(from, to);
    if (regionValue) q = q.eq("region", regionValue);
    return q;
  });
  if (r.error) return { data: [], error: r.error };
  return { data: r.data, error: null };
}
