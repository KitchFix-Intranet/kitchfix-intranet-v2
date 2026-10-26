// src/lib/academy/identity.ts
//
// The ONE authority for Academy identity + scope. Every Academy
// screen resolves through this function. See
// `docs/opd/ACADEMY_MASTER_SPEC.md` (v1 repo) Sections 2.4, 3.1, 3.2,
// 3.3, 3.4 for the design contract.
//
// Sources it reads (spec Section 3.2, allowed set):
//   - people                         (roster, work_email, is_site_leader, ...)
//   - accounts                       (team_key -> region)
//   - academy_person_stints          (worker_id -> person_id)
//   - academy_eligibility_exceptions (include/exclude override)
//   - academy_grants                 (library_admin / academy_admin)
//   - academy_region_leads           (region -> RDO email)
//
// Sources it MUST NOT read (spec Section 3.2, forbidden set):
//   - contacts.role                  (free-text titles; drift-prone)
//   - src/lib/admin.js allowlists    (ops-team gates, not academy)
//   - user_accounts_derived          (single-account projection)
//   - user_accounts_manual           (SC overlay)
//
// If a future change appears to need one of the forbidden sources,
// stop and open a ruling. Silently adding one voids spec 3.2's whole
// point (a coherent role model composed only from clean tables).
//
// v2 fence: in v1 this file carried a pilot preview constant + an
// allowlist. In v2 the fence is `OWNER_EMAILS` via `requireOwnerApi()`
// at the route edge; the resolver here is unchanged in behaviour but
// no longer carries a preview gate.
//
// Seasonal-rehire discipline (spec Section 2.4)
// ─────────────────────────────────────────────
// The join to `people` REQUIRES `status = 'ACTIVE'`. 142 of the
// 887 humans in the roster hold multiple worker_id rows because
// seasonal staff are rehired under a new stint each season while
// keeping the same work_email. Omitting the filter returns multiple
// rows for one login. If the filter is present and MORE THAN ONE
// active row still matches, that is a defect (unique-index breach
// or leaked non-active row), NOT a fallback: this resolver logs it
// loudly and returns null rather than silently picking the first.
//
// PII posture
// ───────────
// This module never selects `personal_email` or `natural_key` and
// never returns either.
//
// Why the eligibility count is split salaried / hourly
// ────────────────────────────────────────────────────
// The Academy renders two DISTINCT cards for the two populations:
// the salaried standing card and the hourly roster card. Each must
// gate on its own population - a single mixed count would render the
// salaried card empty for the three site leaders who have exactly
// one eligible salaried person (self) but a non-zero hourly roster.
// Verified against production 2026-08-31. Do not collapse this back
// into one number.
//
// Cache posture
// ─────────────
// No process-lifetime cache. This resolver runs per request.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

export type AcademyGrant = "library_admin" | "academy_admin";
export type AcademyScopeKind = "company" | "region" | "site" | "self";

export interface AcademyScope {
  kind: AcademyScopeKind;
  region: string | null;
  accounts: string[];
}

export interface AcademyIdentity {
  workerId: string;
  personId: string | null;
  displayName: string | null;
  roleTitle: string | null;
  eligible: boolean;
  isSalaried: boolean;
  accountKey: string | null;
  region: string | null;
  isSiteLeader: boolean;
  isCorp: boolean;
  grants: AcademyGrant[];
  scope: AcademyScope;
}

export interface EligibleCounts {
  salaried: number;
  hourly: number;
  total: number;
}

interface ResolverOpts {
  supa?: SupabaseClient;
}

function normEmail(e: string | null | undefined): string {
  return String(e || "").trim().toLowerCase();
}

/**
 * Resolve the signed-in email to an Academy identity.
 */
export async function resolveAcademyIdentity(
  sessionEmail: string,
  { supa }: ResolverOpts = {}
): Promise<AcademyIdentity | null> {
  const email = normEmail(sessionEmail);
  if (!email) return null;
  const db: SupabaseClient = supa || serviceClient();

  // Step 1. Roster resolution. status='ACTIVE' is LOAD-BEARING - see
  // the seasonal-rehire discipline note in the file header.
  const peopleQ = await db
    .from("people")
    .select(
      "worker_id, display_name, title, account_key, is_corp, is_salaried, is_site_leader, status"
    )
    .eq("status", "ACTIVE")
    .ilike("work_email", email);
  if (peopleQ.error) {
    console.error("[academy/identity] people lookup:", peopleQ.error.message);
    return null;
  }
  const rows = (peopleQ.data || []) as Array<{
    worker_id: string;
    display_name: string | null;
    title: string | null;
    account_key: string | null;
    is_corp: boolean | null;
    is_salaried: boolean | null;
    is_site_leader: boolean | null;
    status: string | null;
  }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Defect, not a fallback. Log with the email and the worker_ids
    // so the drift is visible and traceable, then decline.
    const workerIds = rows.map((r) => r.worker_id).join(",");
    console.error(
      `[academy/identity] duplicate active people rows for one email: email=${email} worker_ids=${workerIds}`
    );
    return null;
  }
  const p = rows[0];
  const workerId = p.worker_id;
  const accountKey = p.account_key;

  // Steps 2-6 fan out in parallel. Every one of these queries is
  // small (single-key point read or a short list) and none depend on
  // one another's results.
  const [stintQ, excQ, grantsQ, regionLeadQ, accountRegionQ] = await Promise.all([
    db
      .from("academy_person_stints")
      .select("person_id")
      .eq("worker_id", workerId)
      .maybeSingle(),
    db
      .from("academy_eligibility_exceptions")
      .select("eligible")
      .eq("worker_id", workerId)
      .maybeSingle(),
    db.from("academy_grants").select("grant_type").eq("email", email),
    db.from("academy_region_leads").select("region").eq("email", email),
    accountKey
      ? db
          .from("accounts")
          .select("region")
          .eq("team_key", accountKey)
          .maybeSingle()
      : Promise.resolve({ data: null as { region: string | null } | null, error: null }),
  ]);

  // person_id: absence is expected drift until the derive extension
  // ships. Not fatal - return null for personId and log.
  let personId: string | null = null;
  if (stintQ.error) {
    console.error("[academy/identity] stint lookup:", stintQ.error.message);
  } else if (stintQ.data) {
    personId = (stintQ.data as { person_id: string }).person_id;
  } else {
    console.warn(
      `[academy/identity] no academy_person_stints row for worker_id=${workerId} (derive drift; expected once new hires arrive before derive extension ships)`
    );
  }

  // eligible: absence means eligible. An exception row's value wins
  // whether it is true or false.
  let eligible = true;
  if (excQ.error) {
    console.error("[academy/identity] exception lookup:", excQ.error.message);
  } else if (excQ.data) {
    eligible = !!(excQ.data as { eligible: boolean }).eligible;
  }

  // grants: zero or more rows. Deduplicate defensively.
  const grants: AcademyGrant[] = [];
  if (grantsQ.error) {
    console.error("[academy/identity] grants lookup:", grantsQ.error.message);
  } else {
    const seen = new Set<string>();
    for (const g of (grantsQ.data || []) as Array<{ grant_type: string }>) {
      if (!seen.has(g.grant_type)) {
        seen.add(g.grant_type);
        grants.push(g.grant_type as AcademyGrant);
      }
    }
  }

  // region: from accounts.region for this account_key. Independent
  // of scope resolution below.
  let region: string | null = null;
  if (accountRegionQ.error) {
    console.error("[academy/identity] account region:", accountRegionQ.error.message);
  } else if (accountRegionQ.data) {
    region = (accountRegionQ.data as { region: string | null }).region || null;
  }

  // Region-lead lookup: only needs to know THIS email leads SOME
  // region for scope precedence.
  let leadsRegion: string | null = null;
  if (regionLeadQ.error) {
    console.error("[academy/identity] region lead lookup:", regionLeadQ.error.message);
  } else if (((regionLeadQ.data as Array<{ region: string }>) || []).length > 0) {
    leadsRegion = (regionLeadQ.data as Array<{ region: string }>)[0].region;
  }

  // Scope (spec Section 3.4, strict precedence, first match wins).
  const scope: AcademyScope = { kind: "self", region: null, accounts: [] };

  if (grants.includes("academy_admin")) {
    // Company scope: all active accounts.
    const accountsQ = await db
      .from("accounts")
      .select("team_key, active")
      .neq("active", false); // NULL treated as active, matches SC pattern
    if (accountsQ.error) {
      console.error("[academy/identity] all-accounts:", accountsQ.error.message);
    } else {
      scope.kind = "company";
      scope.region = null;
      scope.accounts = ((accountsQ.data as Array<{ team_key: string | null }>) || [])
        .map((a) => a.team_key)
        .filter((x): x is string => Boolean(x));
    }
  } else if (leadsRegion) {
    const accountsQ = await db
      .from("accounts")
      .select("team_key, active")
      .eq("region", leadsRegion)
      .neq("active", false);
    if (accountsQ.error) {
      console.error("[academy/identity] region-accounts:", accountsQ.error.message);
    } else {
      scope.kind = "region";
      scope.region = leadsRegion;
      scope.accounts = ((accountsQ.data as Array<{ team_key: string | null }>) || [])
        .map((a) => a.team_key)
        .filter((x): x is string => Boolean(x));
    }
  } else if (p.is_site_leader && accountKey) {
    scope.kind = "site";
    scope.region = null;
    scope.accounts = [accountKey];
  } else {
    scope.kind = "self";
    scope.region = null;
    scope.accounts = [];
  }

  return {
    workerId,
    personId,
    displayName: p.display_name || null,
    // people.title is the display role (e.g. "Director of Operations"),
    // separate from account_key which is the site code. The rail needs
    // this to render a role beneath the person's name.
    roleTitle: p.title || null,
    eligible,
    isSalaried: !!p.is_salaried,
    accountKey: accountKey || null,
    region,
    isSiteLeader: !!p.is_site_leader,
    isCorp: !!p.is_corp,
    grants,
    scope,
  };
}

/**
 * Count eligible people in scope, split by class. Returns
 * `{ salaried, hourly, total }`. See the file header for why the
 * split is load-bearing.
 */
export async function eligibleCountInScope(
  identity: AcademyIdentity | null,
  { supa }: ResolverOpts = {}
): Promise<EligibleCounts> {
  const zeroes: EligibleCounts = { salaried: 0, hourly: 0, total: 0 };
  if (!identity) return zeroes;
  const { scope, workerId } = identity;
  if (!scope || !Array.isArray(scope.accounts) || scope.accounts.length === 0) {
    return zeroes;
  }
  const db: SupabaseClient = supa || serviceClient();

  const [rowsQ, excQ] = await Promise.all([
    db
      .from("people")
      .select("worker_id, is_salaried")
      .is("end_date", null)
      .in("account_key", scope.accounts)
      .neq("worker_id", workerId),
    db
      .from("academy_eligibility_exceptions")
      .select("worker_id")
      .eq("eligible", false),
  ]);
  if (rowsQ.error) {
    console.error("[academy/eligibleCountInScope] people fetch:", rowsQ.error.message);
    return zeroes;
  }
  if (excQ.error) {
    console.error("[academy/eligibleCountInScope] exception scan:", excQ.error.message);
    return zeroes;
  }
  const excluded = new Set(
    ((excQ.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id)
  );

  let salaried = 0;
  let hourly = 0;
  for (const r of (rowsQ.data as Array<{ worker_id: string; is_salaried: boolean | null }>) || []) {
    if (excluded.has(r.worker_id)) continue;
    if (r.is_salaried) salaried += 1;
    else hourly += 1;
  }
  return { salaried, hourly, total: salaried + hourly };
}

/**
 * Salaried standing card visibility (spec Section 3.3). Returns true
 * only when at least one eligible SALARIED person other than the
 * viewer sits inside scope.accounts.
 */
export async function canSeeStandingCard(
  identity: AcademyIdentity | null,
  opts?: ResolverOpts
): Promise<boolean> {
  const c = await eligibleCountInScope(identity, opts || {});
  return c.salaried > 0;
}

/**
 * Hourly roster card visibility (spec Section 10.3).
 */
export async function canSeeHourlyRoster(
  identity: AcademyIdentity | null,
  opts?: ResolverOpts
): Promise<boolean> {
  const c = await eligibleCountInScope(identity, opts || {});
  return c.hourly > 0;
}
