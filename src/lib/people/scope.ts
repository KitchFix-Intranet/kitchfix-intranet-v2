// Scope rules (R-PP17). Server-only. No client code imports this.
//
// Order is a ruling (pin 2, 2026-11-11): regional_director is tested
// BEFORE corporate because both carry is_corp=true on the row. If we
// tested is_corp first, every RD would be mis-classified as
// corporate and miss their region's sites.

import type { PeopleRow, Viewer, ViewerRole, AccountRow } from "./types";

export function resolveRole(row: PeopleRow): ViewerRole | null {
  // Regional director before corporate. Both are is_corp.
  if (row.is_regional_director) return "regional_director";
  if (row.is_corp) return "corporate";
  if (row.is_site_leader) return "site_leader";
  // Salaried on a site, not the leader: site manager.
  if (row.is_salaried) return "site_manager";
  // Hourly non-manager: no role among the four. The page shows an
  // honest empty state ("Nobody to show for this person.") per
  // Kevin ruling 2026-11-11.
  return null;
}

// Decide whether `person` is in scope for `viewer`. Scope is
// enforced here before anything leaves the loader; the card page
// also calls this directly before loading a specific person's
// details (pin 1). `accountRegionByKey` is the accounts.region map
// keyed by team_key - used by the regional_director branch.
export function inScope(
  viewer: Viewer,
  person: PeopleRow,
  accountRegionByKey: Map<string, string | null>,
): boolean {
  // Everyone sees their own card (pinned first in the UI). The
  // loader applies the pin; here we just confirm the self-row
  // passes scope regardless of role.
  if (person.worker_id === viewer.worker_id) return true;

  switch (viewer.role) {
    case "corporate":
      // All ACTIVE people (status filter is upstream).
      return true;

    case "regional_director": {
      // Every site in their region, PLUS corporate people.
      if (person.is_corp) return true;
      // Join via accounts.region - do NOT read people.region on
      // site rows (it is null for site people per prompt §2).
      const personRegion = accountRegionByKey.get(person.account_key) ?? null;
      return personRegion !== null && personRegion === viewer.region;
    }

    case "site_leader":
      // Their site, salaried managers included (no filter beyond
      // the account_key match).
      return person.account_key === viewer.account_key;

    case "site_manager":
      // Themselves (covered above) and the site's hourly people
      // only. No leader row, no other salaried rows.
      if (person.account_key !== viewer.account_key) return false;
      if (person.is_salaried) return false;
      return true;

    case null:
    default:
      // No role: no one is in scope (the page renders empty-state
      // copy instead of calling this).
      return false;
  }
}

// Owner-preview "View as" grants nothing. It swaps the Viewer
// struct wholesale. This helper keeps the role-order rule pinned
// in one place; pages call `buildViewer()` with the override row
// and `resolveRole` runs the same order every time.
export function buildViewer(
  row: PeopleRow,
  previewOf: { worker_id: string; display_name: string } | null,
): Viewer {
  return {
    worker_id: row.worker_id,
    display_name: row.display_name ?? "",
    work_email: row.work_email ?? "",
    account_key: row.account_key,
    region: row.region,
    role: resolveRole(row),
    is_corp: !!row.is_corp,
    is_regional_director: !!row.is_regional_director,
    is_site_leader: !!row.is_site_leader,
    is_salaried: !!row.is_salaried,
    pp_full_access: !!row.pp_full_access,
    pp_review: !!row.pp_review,
    previewOf,
  };
}

// Narrow the accounts list the site-nav will render for a viewer.
// Exported separately because the UI composes it from the already-
// in-scope people (so the counts are exact).
export function siteNavRegionLabel(region: string | null): string {
  return region ?? "";
}
