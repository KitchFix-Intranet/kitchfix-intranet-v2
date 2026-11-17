// Three-path visibility for the calendar.
//
// Both regional directors in `people` carry is_corp = true as well as
// is_regional_director. The order below is the lane's rule, Nov 16:
//   1. regional director -> accounts in their region, and only those
//   2. corporate         -> every calendar account
//   3. salaried          -> their own account
// Anything else (hourly, no role) -> no sites.
//
// This is the calendar's rule, not a side-effect of any other lane.

import type { ViewerLite, SiteNavItem, SiteInfo, AccountLite } from "./types";
import { accountKeyToSlug } from "./slug";

export function visibleSites(
  viewer: ViewerLite,
  calendarAccounts: readonly AccountLite[],
): SiteNavItem[] {
  const toNav = (a: AccountLite): SiteNavItem => ({
    accountKey: a.team_key,
    slug: accountKeyToSlug(a.team_key),
    name: a.name ?? a.team_key,
    region: a.region,
  });

  if (viewer.is_regional_director) {
    const region = viewer.region;
    if (!region) return [];
    return calendarAccounts.filter((a) => a.region === region).map(toNav);
  }

  if (viewer.is_corp) {
    return calendarAccounts.map(toNav);
  }

  if (viewer.is_salaried) {
    return calendarAccounts
      .filter((a) => a.team_key === viewer.account_key)
      .map(toNav);
  }

  return [];
}

// Build a SiteInfo from one account + its qbo_account_map row.
export function siteInfoFrom(
  acc: AccountLite,
  qboMap: { cadence: "weekly" | "biweekly" | null; active: boolean | null } | null,
): SiteInfo {
  // isBilled: a row exists in sc_qbo_account_map, regardless of `active`.
  // A deactivated billing row still means the site was once billed from
  // the calendar; current billing is decided at submit time, not here.
  const isBilled = qboMap !== null;
  // Default cadence weekly when the row exists but cadence is null, or
  // when there is no row at all.
  const cadence: "weekly" | "biweekly" = qboMap?.cadence === "biweekly" ? "biweekly" : "weekly";
  return {
    accountKey: acc.team_key,
    slug: accountKeyToSlug(acc.team_key),
    name: acc.name ?? acc.team_key,
    region: acc.region,
    level: acc.level,
    isBilled,
    cadence,
    timezone: acc.timezone,
  };
}
