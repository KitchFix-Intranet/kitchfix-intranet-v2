// src/lib/academy/access.ts
//
// Viewer-role resolver + path allowlist for the release-controlled
// app-access gate. See src/lib/gate.ts for the gate helpers that
// consume this (`requireAppAccess` + `requireAppAccessApi`).
//
// Roles (strict precedence, first match wins):
//   owner    - email in OWNER_EMAILS. Always allowed, every path.
//   lead     - non-owner who leads at least one group of people:
//              people.is_site_leader = true for themselves, OR
//              one or more direct reports (people row with
//              manager_worker_id = their worker_id), OR
//              a row in academy_region_leads for their email.
//              Leads get the learner surfaces + /academy/team.
//   learner  - non-owner on the active roster through
//              resolveAcademyIdentity (identity.eligible !== false).
//              Gets the learner loop + Library.
//   denied   - authenticated but not on the roster, or the identity
//              resolver declines (e.g. duplicate-active-row defect).
//              No access anywhere, flag on or off.
//
// Path allowlist. Only these paths are OPENED to non-owners when the
// release flag is on. Everything else - Home, Stockpot, Admin, every
// unlisted route - stays owner-only even with the flag on.
//
//   /academy                    lead | learner
//   /academy/done               lead | learner
//   /academy/read/*             lead | learner
//   /library                    lead | learner
//   /library/*                  lead | learner       (includes /library/shelves)
//   /academy/team               lead only            (route reserved; page is NEXT train)
//
// Deliberately NOT opened: /academy/admin and /academy/admin/*
// (owner-only, defense-in-depth with each admin page's own
// requireOwnerPage), /stockpot/*, / (Home), and every other prefix.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ownerEmails } from "@/lib/supabase/env";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity, type AcademyIdentity } from "./identity";

export type ViewerRole = "owner" | "lead" | "learner" | "denied";

export interface ViewerAccess {
  email: string;
  role: ViewerRole;
  identity: AcademyIdentity | null;
  // Lead reasons - any-of signals populated when role === "lead".
  // Null for owner/denied. On learner all three are false. Non-null
  // on lead with at least one `true` for traceability in a probe.
  leadReasons: null | {
    isSiteLeader: boolean;
    hasDirectReports: boolean;
    isRegionLead: boolean;
  };
}

function normEmail(e: string | null | undefined): string {
  return String(e || "").trim().toLowerCase();
}

/**
 * Resolve the signed-in email to its viewer role + academy identity.
 *
 * - Owners short-circuit (no DB reads) so the common case stays
 *   fast. Owner's `identity` is still null; downstream code may
 *   resolve it separately if needed.
 * - Non-owners run the Academy identity resolver. A null identity
 *   or `eligible === false` yields `denied`.
 * - The lead-reason signals run with the service client (not the
 *   caller's session) because `academy_region_leads` and the
 *   direct-report pattern cross RLS boundaries. The checks are
 *   point reads scoped to the resolved worker_id / email, nothing
 *   else is pulled.
 */
export async function resolveViewerRole(
  sessionEmail: string | null,
  opts: { supa?: SupabaseClient } = {},
): Promise<ViewerAccess> {
  const email = normEmail(sessionEmail);
  if (!email) {
    return { email: "", role: "denied", identity: null, leadReasons: null };
  }

  // Owner short-circuit.
  if (ownerEmails().has(email)) {
    return { email, role: "owner", identity: null, leadReasons: null };
  }

  const supa: SupabaseClient = opts.supa ?? serviceClient();
  const identity = await resolveAcademyIdentity(email, { supa });
  if (!identity) {
    return { email, role: "denied", identity: null, leadReasons: null };
  }
  if (identity.eligible === false) {
    // Explicit exclusion - the engine refuses to assign work, so the
    // app refuses to render the surfaces that would depend on it.
    return { email, role: "denied", identity, leadReasons: null };
  }

  // Lead signals - any-of. isSiteLeader is already on identity; the
  // other two are small point reads keyed on worker_id / email.
  const isSiteLeader = !!identity.isSiteLeader;
  const [reportsQ, regionLeadQ] = await Promise.all([
    supa
      .from("people")
      .select("worker_id", { count: "exact", head: true })
      .eq("manager_worker_id", identity.workerId)
      .eq("status", "ACTIVE"),
    supa.from("academy_region_leads").select("region").eq("email", email),
  ]);
  const hasDirectReports = !reportsQ.error && (reportsQ.count || 0) > 0;
  const isRegionLead =
    !regionLeadQ.error && ((regionLeadQ.data as unknown[]) || []).length > 0;

  if (isSiteLeader || hasDirectReports || isRegionLead) {
    return {
      email,
      role: "lead",
      identity,
      leadReasons: { isSiteLeader, hasDirectReports, isRegionLead },
    };
  }

  return { email, role: "learner", identity, leadReasons: null };
}

// ---------------------------------------------------------------------
// Path allowlist. Returns whether (role, pathname) is an opened pair.
// Owner is handled by the gate itself (always true) and is NOT the
// subject of this check - callers should short-circuit owners before
// calling isOpenedPath. On a denied role this always returns false.
// ---------------------------------------------------------------------

export function isOpenedPath(pathname: string, role: ViewerRole): boolean {
  if (role !== "lead" && role !== "learner") return false;
  const p = normalizePath(pathname);

  // /academy/team is lead-only (even flag ON, learners get 404).
  // Keep this check BEFORE the generic /academy prefix check below
  // so a learner is correctly refused.
  if (p === "/academy/team" || p.startsWith("/academy/team/")) {
    return role === "lead";
  }

  // Academy admin is NEVER opened here. The admin pages carry their
  // own requireOwnerPage; this is belt + suspenders at the shell.
  if (p === "/academy/admin" || p.startsWith("/academy/admin/")) {
    return false;
  }

  // Learner surfaces.
  if (p === "/academy") return true;
  if (p === "/academy/done") return true;
  if (p === "/academy/read" || p.startsWith("/academy/read/")) return true;

  // Library (read-only, every path under /library/*).
  if (p === "/library" || p.startsWith("/library/")) return true;

  return false;
}

function normalizePath(input: string | null | undefined): string {
  const raw = String(input || "/").trim();
  if (!raw.startsWith("/")) return "/" + raw;
  // Strip trailing slash except for root.
  if (raw.length > 1 && raw.endsWith("/")) return raw.slice(0, -1);
  // Strip query / hash defensively (callers may pass full URLs).
  const qs = raw.indexOf("?");
  const hs = raw.indexOf("#");
  let end = raw.length;
  if (qs >= 0) end = Math.min(end, qs);
  if (hs >= 0) end = Math.min(end, hs);
  return raw.slice(0, end) || "/";
}
