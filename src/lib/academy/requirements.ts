// src/lib/academy/requirements.ts
//
// The requirements issuance engine. See the v1 spec,
// `docs/opd/ACADEMY_MASTER_SPEC.md`, Sections 5 and 6 for the design.
//
// One eligibility filter. Every trigger (cycle publish, onboarding,
// rehire) resolves audience through the SAME evaluateEligibility()
// function. Duplicating that logic is the drift risk this file
// deliberately closes.
//
// Sources it reads (all clean tables):
//   - people                          roster
//   - accounts                        for state scope (via account_key)
//   - academy_obligations             obligation shape + applies_to
//   - academy_cycles                  cycle status + dates
//   - academy_cycle_modules           what a cycle contains
//   - academy_person_stints           worker_id -> person_id
//   - academy_eligibility_exceptions  include/exclude override
//   - academy_requirements            for idempotency + rehire detection
//
// Nothing in train A calls `applyCyclePublish` or `applyRequirements`;
// they exist for train E. The port keeps them so the engine is intact.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";

// ═══════════════════════════════════════════════════════════════
// The onboarding boundary. Recommended default: NO backfill.
// Onboarding issues only when status = 'HIRED' OR start_date >=
// ACADEMY_LAUNCH_DATE. A single named constant so the boundary
// decision is greppable and edit-visible.
// ═══════════════════════════════════════════════════════════════
export const ACADEMY_LAUNCH_DATE = "2026-09-01";

export const REQUIREMENT_SOURCE_CYCLE = "cycle" as const;
export const REQUIREMENT_SOURCE_ONBOARDING = "onboarding" as const;
export const REQUIREMENT_SOURCE_REHIRE = "rehire" as const;

export type RequirementSource =
  | typeof REQUIREMENT_SOURCE_CYCLE
  | typeof REQUIREMENT_SOURCE_ONBOARDING
  | typeof REQUIREMENT_SOURCE_REHIRE;

export interface PersonRow {
  worker_id: string;
  display_name?: string | null;
  is_salaried?: boolean | null;
  account_key?: string | null;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface ObligationRow {
  doc_id: string;
  obligation_key: string;
  doc_version?: string | number | null;
  est_minutes?: number | null;
  applies_to?: string | Record<string, unknown> | null;
  type?: string | null;
  cadence?: string | null;
  owner?: string | null;
}

export interface EligibilityContext {
  excludedWorkerIds?: Set<string>;
  accountStateMap?: Map<string, string | null>;
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string | null;
  roleWarning?: true;
}

// ─── eligibility (spec Section 5.2, one implementation) ────────────
export function evaluateEligibility(
  person: PersonRow,
  obligation: ObligationRow,
  context: EligibilityContext = {}
): EligibilityVerdict {
  const excludedWorkerIds = context.excludedWorkerIds || new Set<string>();
  const accountStateMap = context.accountStateMap || new Map<string, string | null>();

  if (person.end_date != null) {
    return { eligible: false, reason: "end_date not null" };
  }
  if (excludedWorkerIds.has(person.worker_id)) {
    return { eligible: false, reason: "eligibility exception (excluded)" };
  }

  const at = obligation.applies_to;
  let scope: Record<string, unknown> | null = null;
  if (at == null) {
    scope = null;
  } else if (typeof at === "string") {
    if (at !== "company-wide") {
      return {
        eligible: false,
        reason: `applies_to string "${at}" is not "company-wide"`,
      };
    }
    scope = null;
  } else if (typeof at === "object") {
    scope = at as Record<string, unknown>;
  } else {
    return {
      eligible: false,
      reason: `applies_to shape unknown (${typeof at})`,
    };
  }

  if (scope) {
    const wc = scope.worker_class as string | undefined;
    if (wc != null) {
      if (wc === "all") {
        // matches everyone
      } else if (wc === "salaried") {
        if (!person.is_salaried) {
          return {
            eligible: false,
            reason: "worker_class=salaried, viewer is hourly",
          };
        }
      } else if (wc === "hourly") {
        if (person.is_salaried) {
          return {
            eligible: false,
            reason: "worker_class=hourly, viewer is salaried",
          };
        }
      } else {
        return {
          eligible: false,
          reason: `worker_class value unknown ("${wc}")`,
        };
      }
    }

    const scopeAccount = scope.account as string | undefined;
    if (scopeAccount != null && scopeAccount !== "") {
      if (person.account_key !== scopeAccount) {
        return {
          eligible: false,
          reason: `account "${person.account_key || "(null)"}" does not match applies_to.account "${scopeAccount}"`,
        };
      }
    }

    const scopeStates = scope.states as string[] | undefined;
    if (Array.isArray(scopeStates) && scopeStates.length > 0) {
      const st = accountStateMap.get(person.account_key || "");
      if (st == null) {
        return {
          eligible: false,
          reason: `applies_to.states set (${scopeStates.join(",")}) but no accounts.state for "${person.account_key || "(null)"}"`,
        };
      }
      if (!scopeStates.includes(st)) {
        return {
          eligible: false,
          reason: `accounts.state "${st}" not in applies_to.states [${scopeStates.join(",")}]`,
        };
      }
    }

    const scopeRole = scope.role as string | undefined;
    if (scopeRole != null && scopeRole !== "") {
      // v1 cannot honour role scope (spec Section 3.2). Skip and flag.
      return {
        eligible: false,
        reason: `applies_to.role="${scopeRole}" - v1 cannot honour role scope (spec Section 3.2)`,
        roleWarning: true,
      };
    }
  }

  return { eligible: true, reason: null };
}

// ─── shared loaders ────────────────────────────────────────────────

async function loadExcludedWorkerIds(supa: SupabaseClient): Promise<Set<string>> {
  const q = await supa
    .from("academy_eligibility_exceptions")
    .select("worker_id")
    .eq("eligible", false);
  if (q.error) throw new Error(`load exceptions: ${q.error.message}`);
  return new Set(((q.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id));
}

async function loadAccountStateMap(
  supa: SupabaseClient
): Promise<Map<string, string | null>> {
  const q = await supa
    .from("accounts")
    .select("team_key, state")
    .neq("active", false);
  if (q.error) throw new Error(`load accounts: ${q.error.message}`);
  const m = new Map<string, string | null>();
  for (const a of (q.data as Array<{ team_key: string | null; state: string | null }>) || []) {
    if (a.team_key) m.set(a.team_key, a.state || null);
  }
  return m;
}

// Paginated select. See the v1 header for the full discipline; the
// loader loops with `.range()` and asserts against { count: "exact" }.
type PageFn<T> = (
  from: number,
  to: number
) => Promise<{ data: T[] | null; error: { message: string } | null; count: number | null }>;

async function selectAllPaginated<T>(
  queryFn: PageFn<T>,
  opts: { pageSize?: number; tableName?: string } = {}
): Promise<T[]> {
  const { pageSize = 1000, tableName = "(unspecified)" } = opts;
  const all: T[] = [];
  let expectedTotal: number | null = null;
  let from = 0;
  for (let i = 0; i < 100; i += 1) {
    const to = from + pageSize - 1;
    const q = await queryFn(from, to);
    if (q.error) throw new Error(`selectAllPaginated[${tableName}]: ${q.error.message}`);
    if (expectedTotal === null && typeof q.count === "number") {
      expectedTotal = q.count;
    }
    const rows = q.data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from = to + 1;
  }
  if (from === 100 * pageSize) {
    throw new Error(
      `selectAllPaginated[${tableName}]: hit 100-page ceiling (${all.length} rows) - the loader is probably pointing at the wrong table`
    );
  }
  if (expectedTotal === null) {
    throw new Error(
      `selectAllPaginated[${tableName}]: no exact count returned - caller must build the query with { count: "exact" } so the walk can be verified`
    );
  }
  if (all.length !== expectedTotal) {
    throw new Error(
      `selectAllPaginated[${tableName}]: paged total ${all.length} != exact count ${expectedTotal}. Pagination is wrong; verify .order() precedes .range() and that no concurrent writes happened mid-walk.`
    );
  }
  return all;
}

interface LoadPeopleOptions {
  includeHired?: boolean;
  includeActive?: boolean;
}

async function loadPeoplePool(
  supa: SupabaseClient,
  options: LoadPeopleOptions = {}
): Promise<PersonRow[]> {
  const { includeHired = true, includeActive = true } = options;
  const rows = await selectAllPaginated<PersonRow>(
    (from, to) =>
      supa
        .from("people")
        .select(
          "worker_id, display_name, is_salaried, account_key, status, start_date, end_date",
          { count: "exact" }
        )
        .is("end_date", null)
        .order("worker_id", { ascending: true })
        .range(from, to) as unknown as ReturnType<PageFn<PersonRow>>,
    { tableName: "people (end_date IS NULL)" }
  );
  let filtered = rows;
  if (!includeHired) filtered = filtered.filter((r) => r.status !== "HIRED");
  if (!includeActive) filtered = filtered.filter((r) => r.status !== "ACTIVE");
  return filtered;
}

async function loadStintMap(supa: SupabaseClient): Promise<Map<string, string>> {
  const rows = await selectAllPaginated<{ worker_id: string; person_id: string }>(
    (from, to) =>
      supa
        .from("academy_person_stints")
        .select("worker_id, person_id", { count: "exact" })
        .order("worker_id", { ascending: true })
        .range(from, to) as unknown as ReturnType<
        PageFn<{ worker_id: string; person_id: string }>
      >,
    { tableName: "academy_person_stints" }
  );
  const m = new Map<string, string>();
  for (const s of rows) m.set(s.worker_id, s.person_id);
  return m;
}

// ─── cycle audience scope (academy-6) ──────────────────────────────

const VALID_SCOPE_WORKER_CLASS = new Set(["all", "salaried", "hourly"]);

export interface AudienceScope {
  worker_class?: string;
  accounts?: string[];
  regions?: string[];
  worker_ids?: string[];
}

export interface ScopeValidationCtx {
  knownAccountKeys: Set<string>;
  knownRegions: Set<string>;
  activeWorkerIdsSet: Set<string>;
}

export function validateAudienceScope(
  scope: AudienceScope | null | undefined,
  ctx: ScopeValidationCtx
): string[] {
  const errors: string[] = [];
  if (scope == null) return errors;
  if (typeof scope !== "object" || Array.isArray(scope)) {
    return [
      `audience_scope must be an object, got ${Array.isArray(scope) ? "array" : typeof scope}`,
    ];
  }
  if (scope.worker_class != null) {
    if (!VALID_SCOPE_WORKER_CLASS.has(scope.worker_class)) {
      errors.push(
        `audience_scope.worker_class "${scope.worker_class}" is not one of all|salaried|hourly`
      );
    }
  }
  if (scope.accounts != null) {
    if (!Array.isArray(scope.accounts)) {
      errors.push("audience_scope.accounts must be an array");
    } else {
      for (const a of scope.accounts) {
        if (typeof a !== "string" || !ctx.knownAccountKeys.has(a)) {
          errors.push(
            `audience_scope.accounts entry "${a}" does not exist in accounts.team_key`
          );
        }
      }
    }
  }
  if (scope.regions != null) {
    if (!Array.isArray(scope.regions)) {
      errors.push("audience_scope.regions must be an array");
    } else {
      for (const r of scope.regions) {
        if (typeof r !== "string" || !ctx.knownRegions.has(r)) {
          errors.push(
            `audience_scope.regions entry "${r}" does not exist in accounts.region`
          );
        }
      }
    }
  }
  if (scope.worker_ids != null) {
    if (!Array.isArray(scope.worker_ids)) {
      errors.push("audience_scope.worker_ids must be an array");
    } else {
      for (const w of scope.worker_ids) {
        if (typeof w !== "string" || !ctx.activeWorkerIdsSet.has(w)) {
          errors.push(
            `audience_scope.worker_ids entry "${w}" is not a people row with end_date IS NULL`
          );
        }
      }
    }
  }
  return errors;
}

export interface CycleScopeCtx {
  accountRegionMap?: Map<string, string>;
}

export interface CycleScopeVerdict {
  inScope: boolean;
  reason: string | null;
}

export function evaluateCycleScope(
  person: PersonRow,
  audienceScope: AudienceScope | null | undefined,
  ctx: CycleScopeCtx = {}
): CycleScopeVerdict {
  if (audienceScope == null || typeof audienceScope !== "object") {
    return { inScope: true, reason: null };
  }
  const keys = Object.keys(audienceScope);
  if (keys.length === 0) return { inScope: true, reason: null };

  if (audienceScope.worker_class != null) {
    const wc = audienceScope.worker_class;
    if (wc === "salaried" && !person.is_salaried) {
      return {
        inScope: false,
        reason: "cycle scope worker_class=salaried, viewer is hourly",
      };
    }
    if (wc === "hourly" && person.is_salaried) {
      return {
        inScope: false,
        reason: "cycle scope worker_class=hourly, viewer is salaried",
      };
    }
  }
  if (Array.isArray(audienceScope.accounts) && audienceScope.accounts.length > 0) {
    if (!audienceScope.accounts.includes(person.account_key || "")) {
      return {
        inScope: false,
        reason: `cycle scope accounts excludes viewer's account "${person.account_key || "(none)"}"`,
      };
    }
  }
  if (Array.isArray(audienceScope.regions) && audienceScope.regions.length > 0) {
    const accountRegionMap = ctx.accountRegionMap || new Map<string, string>();
    const region = accountRegionMap.get(person.account_key || "");
    if (!audienceScope.regions.includes(region || "")) {
      return {
        inScope: false,
        reason: `cycle scope regions excludes viewer's region "${region || "(none)"}"`,
      };
    }
  }
  if (Array.isArray(audienceScope.worker_ids) && audienceScope.worker_ids.length > 0) {
    if (!audienceScope.worker_ids.includes(person.worker_id)) {
      return { inScope: false, reason: "cycle scope worker_ids does not include viewer" };
    }
  }
  return { inScope: true, reason: null };
}

async function loadObligationsByDocKey(
  supa: SupabaseClient,
  docKeyPairs: Array<{ doc_id: string; obligation_key: string }>
): Promise<Map<string, ObligationRow>> {
  if (docKeyPairs.length === 0) return new Map();
  const uniqueDocs = [...new Set(docKeyPairs.map((p) => p.doc_id))];
  const q = await supa
    .from("academy_obligations")
    .select(
      "doc_id, obligation_key, doc_version, est_minutes, applies_to, type, cadence, owner"
    )
    .in("doc_id", uniqueDocs);
  if (q.error) throw new Error(`load obligations: ${q.error.message}`);
  const m = new Map<string, ObligationRow>();
  for (const r of (q.data as ObligationRow[]) || []) {
    m.set(`${r.doc_id}|${r.obligation_key}`, r);
  }
  return m;
}

// ─── Trigger 1: cycle publish ──────────────────────────────────────

export interface CyclePublishPlan {
  cycle: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  report: Record<string, unknown>;
}

export async function planCyclePublish(
  supa: SupabaseClient | null,
  cycleId: string | number,
  options: { force?: boolean } = {}
): Promise<CyclePublishPlan> {
  const db = supa || serviceClient();

  const cycleQ = await db
    .from("academy_cycles")
    .select("cycle_id, label, period_start, period_end, status, audience_scope")
    .eq("cycle_id", cycleId)
    .maybeSingle();
  if (cycleQ.error) throw new Error(`load cycle ${cycleId}: ${cycleQ.error.message}`);
  if (!cycleQ.data) throw new Error(`cycle ${cycleId} not found`);
  const cycle = cycleQ.data as {
    cycle_id: string | number;
    label: string;
    period_start: string;
    period_end: string;
    status: string;
    audience_scope: AudienceScope | null;
  };
  if (cycle.status !== "draft" && !options.force) {
    throw new Error(
      `cycle ${cycleId} is in status "${cycle.status}"; publish only accepts draft. Pass { force: true } to plan against a non-draft (for reporting only; apply will still refuse).`
    );
  }

  const modulesQ = await db
    .from("academy_cycle_modules")
    .select("doc_id, obligation_key, doc_version, est_minutes, sort_order")
    .eq("cycle_id", cycleId)
    .order("sort_order", { ascending: true })
    .order("doc_id", { ascending: true });
  if (modulesQ.error) throw new Error(`load modules: ${modulesQ.error.message}`);
  const modules = (modulesQ.data as Array<{
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    sort_order: number | null;
  }>) || [];

  const accountsQ = await db
    .from("accounts")
    .select("team_key, state, region")
    .neq("active", false);
  if (accountsQ.error) throw new Error(`load accounts: ${accountsQ.error.message}`);
  const accountRegionMap = new Map<string, string>();
  const knownAccountKeys = new Set<string>();
  const knownRegions = new Set<string>();
  const accountStateMap = new Map<string, string | null>();
  for (const a of (accountsQ.data as Array<{
    team_key: string | null;
    state: string | null;
    region: string | null;
  }>) || []) {
    if (!a.team_key) continue;
    knownAccountKeys.add(a.team_key);
    if (a.state) accountStateMap.set(a.team_key, a.state);
    if (a.region) {
      accountRegionMap.set(a.team_key, a.region);
      knownRegions.add(a.region);
    }
  }

  const [excluded, people, stints, obligations] = await Promise.all([
    loadExcludedWorkerIds(db),
    loadPeoplePool(db, { includeHired: true, includeActive: true }),
    loadStintMap(db),
    loadObligationsByDocKey(db, modules),
  ]);

  const activeWorkerIdsSet = new Set(people.map((p) => p.worker_id));
  const context: EligibilityContext = {
    excludedWorkerIds: excluded,
    accountStateMap,
  };
  const scopeCtx: CycleScopeCtx = { accountRegionMap };

  const scopeRefusals = validateAudienceScope(cycle.audience_scope, {
    knownAccountKeys,
    knownRegions,
    activeWorkerIdsSet,
  });

  const onHireModules: string[] = [];

  if (modules.length === 0) {
    return {
      cycle,
      rows: [],
      report: {
        modules: 0,
        audienceScope: cycle.audience_scope || {},
        peopleAffected: 0,
        totalRequirements: 0,
        byClass: {},
        byAccount: {},
        minutesSummary: { min: 0, max: 0, avg: 0, total: 0 },
        skipped: [],
        scopeSkippedByReason: {},
        roleWarnings: [],
        onHireModules: [],
        scopeRefusals,
        wouldRefuseApply: true,
        refuseReasons: [
          ...scopeRefusals,
          "cycle has zero modules; publishing writes zero requirements",
        ],
        note: "cycle has zero modules; publishing writes zero requirements",
      },
    };
  }

  const rows: Array<Record<string, unknown>> = [];
  const skipped: Array<{ module: string; reason: string }> = [];
  const roleWarnings: Array<{ module: string; worker_id: string; reason: string }> = [];
  const scopeSkippedByReason = new Map<string, number>();
  const seenPeople = new Set<string>();
  const byClass = { salaried: 0, hourly: 0, unknown: 0 };
  const byAccount: Record<string, number> = {};
  const minutesPerPerson = new Map<string, number>();
  const driftCandidates = new Map<
    string,
    { worker_id: string; display_name: string | null; account_key: string | null; reason: string }
  >();

  for (const mod of modules) {
    const key = `${mod.doc_id}|${mod.obligation_key}`;
    const ob = obligations.get(key);
    if (!ob) {
      skipped.push({
        module: key,
        reason:
          "cycle module points at obligation absent from academy_obligations (projection drift; PR 3 obligations RPC has not been re-run since the module was added)",
      });
      continue;
    }
    if (ob.cadence === "on-hire") {
      onHireModules.push(key);
    }

    for (const p of people) {
      const oblVerdict = evaluateEligibility(p, ob, context);
      if (oblVerdict.roleWarning) {
        roleWarnings.push({
          module: key,
          worker_id: p.worker_id,
          reason: oblVerdict.reason || "",
        });
      }
      if (!oblVerdict.eligible) continue;

      const scopeVerdict = evaluateCycleScope(p, cycle.audience_scope, scopeCtx);
      if (!scopeVerdict.inScope) {
        const r = scopeVerdict.reason || "cycle scope excluded (unknown reason)";
        scopeSkippedByReason.set(r, (scopeSkippedByReason.get(r) || 0) + 1);
        continue;
      }

      const stintValue = stints.get(p.worker_id);
      const person_id = stintValue == null ? null : stintValue;
      if (person_id == null) {
        if (!driftCandidates.has(p.worker_id)) {
          driftCandidates.set(p.worker_id, {
            worker_id: p.worker_id,
            display_name: p.display_name || null,
            account_key: p.account_key || null,
            reason:
              "no academy_person_stints row (derive-drift; person exists in people but the derive extension has not populated their stint). Row will issue with person_id=NULL; run backfill_requirement_person_ids() after the stint arrives to fill it retroactively.",
          });
        }
      }
      rows.push({
        worker_id: p.worker_id,
        person_id,
        doc_id: mod.doc_id,
        obligation_key: mod.obligation_key,
        doc_version: mod.doc_version,
        est_minutes: mod.est_minutes,
        due_date: cycle.period_end,
      });

      seenPeople.add(p.worker_id);
      if (p.is_salaried === true) byClass.salaried += 1;
      else if (p.is_salaried === false) byClass.hourly += 1;
      else byClass.unknown += 1;

      const acct = p.account_key || "(no account)";
      byAccount[acct] = (byAccount[acct] || 0) + 1;

      const acc = minutesPerPerson.get(p.worker_id) || 0;
      minutesPerPerson.set(p.worker_id, acc + (mod.est_minutes || 0));
    }
  }

  const minutesList = [...minutesPerPerson.values()];
  const minutesSummary =
    minutesList.length === 0
      ? { min: 0, max: 0, avg: 0, total: 0 }
      : {
          min: Math.min(...minutesList),
          max: Math.max(...minutesList),
          avg: Math.round(minutesList.reduce((a, b) => a + b, 0) / minutesList.length),
          total: minutesList.reduce((a, b) => a + b, 0),
        };

  const refuseReasons = [...scopeRefusals];
  if (rows.length === 0 && modules.length > 0) {
    refuseReasons.push(
      `cycle resolves to zero people (modules=${modules.length}, audience_scope=${JSON.stringify(cycle.audience_scope || {})}). A cycle that reaches nobody is almost always a scope typo; refuse rather than publish an empty cycle that reports "complete".`
    );
  }

  return {
    cycle,
    rows,
    report: {
      modules: modules.length,
      audienceScope: cycle.audience_scope || {},
      peopleAffected: seenPeople.size,
      totalRequirements: rows.length,
      byClass,
      byAccount,
      minutesSummary,
      skipped,
      scopeSkippedByReason: Object.fromEntries(scopeSkippedByReason),
      roleWarnings,
      onHireModules,
      driftCandidates: [...driftCandidates.values()],
      scopeRefusals,
      refuseReasons,
      wouldRefuseApply: refuseReasons.length > 0,
    },
  };
}

export async function applyCyclePublish(
  supa: SupabaseClient | null,
  cycleId: string | number,
  publishedBy: string,
  plan: CyclePublishPlan
): Promise<unknown> {
  const db = supa || serviceClient();

  const report = plan?.report as { wouldRefuseApply?: boolean; refuseReasons?: string[] } | undefined;
  if (report?.wouldRefuseApply) {
    const reasons = (report.refuseReasons || []).map((r: string) => `  - ${r}`).join("\n");
    throw new Error(
      `applyCyclePublish refused: plan would refuse to publish (see planCyclePublish report). Reasons:\n${reasons || "  (no reasons captured)"}`
    );
  }

  const q = await db.rpc("publish_cycle_atomic", {
    p_cycle_id: cycleId,
    p_published_by: publishedBy,
    p_rows: plan.rows,
  });
  if (q.error) throw new Error(`publish_cycle_atomic: ${q.error.message}`);
  return Array.isArray(q.data) ? q.data[0] : q.data;
}

// ─── Trigger 2: onboarding ─────────────────────────────────────────

export interface OnboardingOptions {
  backfill?: boolean;
  launchDate?: string;
}

export interface OnboardingPlan {
  launchDate: string;
  rows: Array<Record<string, unknown>>;
  report: Record<string, unknown>;
}

export async function planOnboarding(
  supa: SupabaseClient | null,
  options: OnboardingOptions = {}
): Promise<OnboardingPlan> {
  const db = supa || serviceClient();
  const launchDate = options.launchDate || ACADEMY_LAUNCH_DATE;
  const backfill = !!options.backfill;

  const [excluded, accountStates, people, stints, obligationsAll] = await Promise.all([
    loadExcludedWorkerIds(db),
    loadAccountStateMap(db),
    loadPeoplePool(db, { includeHired: true, includeActive: true }),
    loadStintMap(db),
    (async () => {
      const q = await db
        .from("academy_obligations")
        .select("doc_id, obligation_key, doc_version, est_minutes, applies_to, cadence")
        .eq("cadence", "on-hire");
      if (q.error) throw new Error(`load on-hire obligations: ${q.error.message}`);
      return (q.data as ObligationRow[]) || [];
    })(),
  ]);

  const context: EligibilityContext = {
    excludedWorkerIds: excluded,
    accountStateMap: accountStates,
  };

  const inBoundary = (p: PersonRow) =>
    p.status === "HIRED" || (p.start_date != null && p.start_date >= launchDate);
  const boundaryPeople = people.filter(inBoundary);

  const rows: Array<Record<string, unknown>> = [];
  const roleWarnings: Array<{ module: string; worker_id: string; reason: string }> = [];
  const skippedByReason = new Map<string, number>();
  let backfillWouldInsert = 0;
  const backfillByClass = { salaried: 0, hourly: 0, unknown: 0 };
  const boundaryByClass = { salaried: 0, hourly: 0, unknown: 0 };
  const driftCandidates = new Map<
    string,
    { worker_id: string; display_name: string | null; account_key: string | null; reason: string }
  >();

  for (const ob of obligationsAll) {
    for (const p of people) {
      const verdict = evaluateEligibility(p, ob, context);
      if (verdict.roleWarning) {
        roleWarnings.push({
          module: `${ob.doc_id}|${ob.obligation_key}`,
          worker_id: p.worker_id,
          reason: verdict.reason || "",
        });
      }
      if (!verdict.eligible) {
        const r = verdict.reason || "unknown";
        skippedByReason.set(r, (skippedByReason.get(r) || 0) + 1);
        continue;
      }
      backfillWouldInsert += 1;
      if (p.is_salaried === true) backfillByClass.salaried += 1;
      else if (p.is_salaried === false) backfillByClass.hourly += 1;
      else backfillByClass.unknown += 1;

      if (!backfill && !inBoundary(p)) continue;

      const stintValue = stints.get(p.worker_id);
      const person_id = stintValue == null ? null : stintValue;
      if (person_id == null && !driftCandidates.has(p.worker_id)) {
        driftCandidates.set(p.worker_id, {
          worker_id: p.worker_id,
          display_name: p.display_name || null,
          account_key: p.account_key || null,
          reason:
            "no academy_person_stints row (derive-drift). Row will issue with person_id=NULL; run backfill_requirement_person_ids() after the stint arrives to fill it retroactively.",
        });
      }
      rows.push({
        worker_id: p.worker_id,
        person_id,
        doc_id: ob.doc_id,
        obligation_key: ob.obligation_key,
        doc_version: ob.doc_version,
        est_minutes: ob.est_minutes,
        source: REQUIREMENT_SOURCE_ONBOARDING,
        cycle_id: null,
        due_date: p.start_date || launchDate,
      });
      if (p.is_salaried === true) boundaryByClass.salaried += 1;
      else if (p.is_salaried === false) boundaryByClass.hourly += 1;
      else boundaryByClass.unknown += 1;
    }
  }

  return {
    launchDate,
    rows,
    report: {
      obligations: obligationsAll.length,
      recommended: {
        peopleAffected: boundaryPeople.length,
        totalRequirements: rows.length,
        byClass: boundaryByClass,
      },
      backfillAlternative: {
        peopleAffected: people.length,
        totalRequirements: backfillWouldInsert,
        byClass: backfillByClass,
        note: "informational only - apply mode never uses this unless { backfill: true } is passed",
      },
      skippedByReason: Object.fromEntries(skippedByReason),
      roleWarnings,
      driftCandidates: [...driftCandidates.values()],
      boundaryPeople: boundaryPeople.map((p) => ({
        worker_id: p.worker_id,
        display_name: p.display_name,
        status: p.status,
        start_date: p.start_date,
        is_salaried: p.is_salaried,
        account_key: p.account_key,
      })),
    },
  };
}

// ─── Trigger 3: rehire ─────────────────────────────────────────────

export interface RehirePlan {
  rows: Array<Record<string, unknown>>;
  report: Record<string, unknown>;
}

export async function planRehire(
  supa: SupabaseClient | null,
  _options: Record<string, unknown> = {}
): Promise<RehirePlan> {
  void _options;
  const db = supa || serviceClient();

  const [stintRows, reqsQ, obligationsQ, excluded, accountStates, people] = await Promise.all([
    selectAllPaginated<{ worker_id: string; person_id: string | null }>(
      (from, to) =>
        db
          .from("academy_person_stints")
          .select("worker_id, person_id", { count: "exact" })
          .order("worker_id", { ascending: true })
          .range(from, to) as unknown as ReturnType<
          PageFn<{ worker_id: string; person_id: string | null }>
        >,
      { tableName: "academy_person_stints (rehire)" }
    ),
    db
      .from("academy_requirements")
      .select("worker_id")
      .eq("source", REQUIREMENT_SOURCE_ONBOARDING),
    db
      .from("academy_obligations")
      .select("doc_id, obligation_key, doc_version, est_minutes, applies_to")
      .eq("cadence", "on-hire"),
    loadExcludedWorkerIds(db),
    loadAccountStateMap(db),
    loadPeoplePool(db, { includeHired: true, includeActive: true }),
  ]);
  for (const q of [reqsQ, obligationsQ]) {
    if (q.error) throw new Error(`rehire plan load: ${q.error.message}`);
  }

  const stintsByPerson = new Map<string, string[]>();
  for (const s of stintRows) {
    if (!s.person_id) continue;
    const arr = stintsByPerson.get(s.person_id) || [];
    arr.push(s.worker_id);
    stintsByPerson.set(s.person_id, arr);
  }
  const multiStintPersonIds = new Set(
    [...stintsByPerson.entries()].filter(([, ws]) => ws.length > 1).map(([pid]) => pid)
  );

  const stintMap = new Map<string, string | null>(
    stintRows.map((s) => [s.worker_id, s.person_id] as [string, string | null])
  );
  const workersWithReqs = new Set(
    ((reqsQ.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id)
  );

  const candidateWorkers: PersonRow[] = [];
  for (const p of people) {
    const pid = stintMap.get(p.worker_id);
    if (!pid) continue;
    if (!multiStintPersonIds.has(pid)) continue;
    if (workersWithReqs.has(p.worker_id)) continue;
    candidateWorkers.push(p);
  }

  const driftCandidates: Array<{
    worker_id: string;
    display_name: string | null;
    reason: string;
  }> = [];
  for (const p of people) {
    if (!stintMap.has(p.worker_id)) {
      driftCandidates.push({
        worker_id: p.worker_id,
        display_name: p.display_name || null,
        reason: "no academy_person_stints row (derive extension not yet shipped)",
      });
    }
  }

  const context: EligibilityContext = {
    excludedWorkerIds: excluded,
    accountStateMap: accountStates,
  };
  const rows: Array<Record<string, unknown>> = [];
  const roleWarnings: Array<{ module: string; worker_id: string; reason: string }> = [];
  const byClass = { salaried: 0, hourly: 0, unknown: 0 };
  for (const p of candidateWorkers) {
    for (const ob of (obligationsQ.data as ObligationRow[]) || []) {
      const verdict = evaluateEligibility(p, ob, context);
      if (verdict.roleWarning) {
        roleWarnings.push({
          module: `${ob.doc_id}|${ob.obligation_key}`,
          worker_id: p.worker_id,
          reason: verdict.reason || "",
        });
      }
      if (!verdict.eligible) continue;
      rows.push({
        worker_id: p.worker_id,
        person_id: stintMap.get(p.worker_id),
        doc_id: ob.doc_id,
        obligation_key: ob.obligation_key,
        doc_version: ob.doc_version,
        est_minutes: ob.est_minutes,
        source: REQUIREMENT_SOURCE_REHIRE,
        cycle_id: null,
        due_date: p.start_date || null,
      });
      if (p.is_salaried === true) byClass.salaried += 1;
      else if (p.is_salaried === false) byClass.hourly += 1;
      else byClass.unknown += 1;
    }
  }

  return {
    rows,
    report: {
      obligations: ((obligationsQ.data as ObligationRow[]) || []).length,
      candidateStints: candidateWorkers.length,
      totalRequirements: rows.length,
      byClass,
      roleWarnings,
      driftCandidates,
    },
  };
}

// ─── apply (non-cycle triggers) ────────────────────────────────────

export interface ApplyRequirementsOptions {
  issuedBy?: string;
}

export async function applyRequirements(
  supa: SupabaseClient | null,
  plan: { rows: Array<Record<string, unknown>> } | undefined,
  options: ApplyRequirementsOptions = {}
): Promise<{ inserted: number; skipped: number }> {
  const db = supa || serviceClient();
  if (!Array.isArray(plan?.rows) || plan!.rows.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const sources = new Set(plan!.rows.map((r) => r.source as string));
  if (sources.has(REQUIREMENT_SOURCE_CYCLE)) {
    throw new Error(
      "applyRequirements refused: plan contains source='cycle' rows. Cycle requirements must go through publish_cycle_atomic to keep status flip + insert atomic."
    );
  }
  if (sources.size !== 1) {
    throw new Error(
      `applyRequirements refused: plan has mixed sources (${[...sources].join(",")}). insert_requirements_bulk takes a single source per call; split the plan by source and call once per group.`
    );
  }
  const source = [...sources][0];
  const issuedBy = options.issuedBy || "system";

  const stripped = plan!.rows.map((r) => ({
    worker_id: r.worker_id,
    person_id: r.person_id,
    doc_id: r.doc_id,
    obligation_key: r.obligation_key,
    doc_version: r.doc_version,
    est_minutes: r.est_minutes,
    due_date: r.due_date,
    issued_by: issuedBy,
  }));

  const q = await db.rpc("insert_requirements_bulk", {
    p_source: source,
    p_rows: stripped,
  });
  if (q.error) throw new Error(`insert_requirements_bulk: ${q.error.message}`);
  const inserted = typeof q.data === "number" ? q.data : Number(q.data);
  if (!Number.isFinite(inserted)) {
    throw new Error(
      `insert_requirements_bulk: non-numeric return value ${JSON.stringify(q.data)}`
    );
  }
  return { inserted, skipped: stripped.length - inserted };
}
