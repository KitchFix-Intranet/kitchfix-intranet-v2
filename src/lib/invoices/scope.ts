// Invoices V2 - scope rule. Pure. Five paths per §4, in exactly
// this order; the order itself is load-bearing because regional
// directors also carry is_corp = true today and a is_corp-first
// test would mis-classify every RD as the office (R-PP17 pattern,
// borrowed as the lane's own rule, not imported).
//
// Signature choices:
//   - The resolver takes a small `ViewerFacts` projection and an
//     `AllSites` list + `AllAccountRegions` map. Callers supply both.
//   - The fifth-path "anyone else" returns an empty list; the page
//     renders a "no access" state, not a 404, so the owner can
//     preview what they would see (§4 rule 5).
//
// Reviewer-also-salaried: a reviewer (is_invoice_admin true) sees
// every site regardless of being salaried at one; the office check
// runs before the salaried check, so there is no ambiguity.

import { accountKeyToSlug } from "./slug";
import type { InvoiceScope, SiteNavItem, ViewerKind } from "./types";

// What the resolver needs from the viewer. A projection of
// `src/lib/people/types.ts :: Viewer` plus the invoice-admin flag
// that `resolveViewer` deliberately does not select (§4).
export interface ViewerFacts {
  is_owner: boolean;            // signed-in owner AND no `as` in URL
  is_invoice_admin: boolean;    // people.is_invoice_admin
  is_regional_director: boolean;
  is_corp: boolean;
  is_salaried: boolean;
  region: string | null;
  account_key: string | null;   // non-null only when tied to a site
}

// A "site" is a row in accounts with active = true AND team_key !=
// 'CORP'. The loader gathers them once at the top of the page and
// hands the full list in. 11 today (9 with invoices, 2 without).
export interface SiteAccount {
  team_key: string;
  name: string | null;
  region: string | null;
}

const SITE_WORDS = {
  fix: "Needs a fix",
  fixPlural: (n: number) => `${n} invoice${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a fix`,
};

const OFFICE_WORDS = {
  fix: "Sent back",
  fixPlural: (n: number) => `${n} invoice${n === 1 ? "" : "s"} sent back`,
};

function toNav(a: SiteAccount): SiteNavItem {
  return {
    accountKey: a.team_key,
    slug: accountKeyToSlug(a.team_key),
    name: a.name ?? a.team_key,
    region: a.region,
  };
}

// The scope rule as a pure function.
// Caller resolves `is_owner` before calling (signed-in owner AND no
// `?as=` override).
//
// Order ruling (2026-11-17, Chat-Claude): `is_invoice_admin` is tested
// BEFORE `is_owner`. The owner-not-previewing rule only decides
// ACCESS ("every site"); the words come from the is_invoice_admin
// flag so an owner who is also a reviewer (Kevin today) sees "Sent
// back" rather than "Needs a fix". An owner without the reviewer
// flag still gets every site via the second branch.
export function resolveInvoiceScope(
  viewer: ViewerFacts,
  sites: readonly SiteAccount[],
): InvoiceScope {
  // 1. Invoice reviewer (the office). Tested first so owners who
  //    carry the flag get the office words.
  if (viewer.is_invoice_admin) {
    return {
      kind: "office",
      accountKeys: sites.map((a) => a.team_key),
      words: OFFICE_WORDS,
    };
  }

  // 2. Owner, not previewing. Train-1 convenience: every site, site
  //    words. An owner who is also an invoice reviewer hit the first
  //    branch above and this one is skipped.
  if (viewer.is_owner) {
    return {
      kind: "owner",
      accountKeys: sites.map((a) => a.team_key),
      words: SITE_WORDS,
    };
  }

  // 3. Regional director. Tested BEFORE corporate because both carry
  // is_corp = true on the people row.
  if (viewer.is_regional_director) {
    const region = viewer.region;
    if (!region) {
      return { kind: "regional_director", accountKeys: [], words: SITE_WORDS };
    }
    const keys = sites
      .filter((a) => a.region === region)
      .map((a) => a.team_key);
    return { kind: "regional_director", accountKeys: keys, words: SITE_WORDS };
  }

  // 4. Salaried AND account_key is a site (one of the in-scope
  // accounts). "Salaried on CORP" or "salaried on a key that is
  // not in the scope list" is not rule 4 - it falls through to
  // rule 5 (no sites) so the surface shows the no-access state.
  if (viewer.is_salaried && viewer.account_key) {
    const inScope = sites.find((a) => a.team_key === viewer.account_key);
    if (inScope) {
      return {
        kind: "site_manager",
        accountKeys: [inScope.team_key],
        words: SITE_WORDS,
      };
    }
  }

  // 5. Anyone else. Empty list -> the surface renders the no-access
  // state (not a 404) so the owner can preview what they would see.
  return { kind: "none", accountKeys: [], words: SITE_WORDS };
}

// Helpers for the surface.
export function sitesInScope(
  scope: InvoiceScope,
  sites: readonly SiteAccount[],
): SiteNavItem[] {
  const keep = new Set(scope.accountKeys);
  return sites.filter((a) => keep.has(a.team_key)).map(toNav);
}

export function isManySites(scope: InvoiceScope): boolean {
  return scope.accountKeys.length > 1;
}

export function viewerKindLabel(kind: ViewerKind): string {
  switch (kind) {
    case "owner": return "All sites";
    case "office": return "All sites";
    case "regional_director": return "My region";
    case "site_manager": return "My site";
    case "none": return "No access";
  }
}
