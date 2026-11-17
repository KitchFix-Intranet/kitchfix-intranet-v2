// src/lib/kpi/roleGate.js (partial move)
//
// Brings `canViewAccount`, `canSeeSalary` and `landingAccount` from
// v1's roleGate.js as plain functions of a caller
// `{ role, scope, can_see_salary }`. Bodies unchanged.
//
// Left behind in v1: `resolveKpiRole`, the reads of `kpi_roles`,
// `accounts` and `people`, and `KPI_PREVIEW_ONLY` / `KPI_PREVIEW_ALLOWLIST`
// (a list of addresses). V2 gets the signed-in person from its own
// shared viewer in a later train.
//
// See v1's src/lib/kpi/roleGate.js for the design contract (four
// owner rulings). Nothing else re-decides.

const PSEUDO_KEYS = new Set(["ALL", "EAST", "WEST"]);
const REGION_TO_PSEUDO = new Map([["East", "EAST"], ["West", "WEST"]]);

export function canViewAccount(caller: any, requestedAccount: any) {
  if (!caller || !requestedAccount) return false;
  const { role, scope } = caller;
  if (role === "corporate") return true;
  if (role === "rdo") return true;                    // §1: RDOs see full picture
  // site_leader / site_manager: own account only, aggregates locked
  if (PSEUDO_KEYS.has(requestedAccount)) return false;
  return requestedAccount === scope;
}

export function canSeeSalary(caller: any, requestedAccount: any) {
  if (!caller || !requestedAccount) return false;
  // role-gates-2 salary suppression - one early return in front of
  // every role branch. A suppression, not a new branch: the
  // existing corporate / rdo / site_leader / site_manager logic
  // underneath is untouched. canViewAccount and landingAccount are
  // NOT affected - a suppressed corporate keeps full view and
  // still lands on ALL.
  if (caller?.can_see_salary === false) return false;
  const { role, scope } = caller;
  if (role === "corporate") return true;
  if (role === "rdo") return true;
  if (role === "site_leader") {
    if (PSEUDO_KEYS.has(requestedAccount)) return false;   // aggregates never
    return requestedAccount === scope;
  }
  // site_manager: never, even for their own account (§5 + §6)
  return false;
}

export function landingAccount(caller: any) {
  if (!caller) return null;
  const { role, scope } = caller;
  if (role === "corporate") return "ALL";
  if (role === "rdo") return REGION_TO_PSEUDO.get(scope) || "ALL";
  // site_leader / site_manager
  return scope;
}
