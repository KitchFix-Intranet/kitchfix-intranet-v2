// Gate helpers. The OWNER_EMAILS allowlist is checked here. A non-owner (or
// unauthenticated request) in a protected page triggers notFound() so Next
// renders the plain app/not-found page. In protected APIs the helper returns
// a Response the handler returns verbatim.
//
// Two tiers:
//
//   requireOwnerPage / requireOwnerApi
//     The historical gate. Admin pages + admin APIs call these; they
//     stay owner-only regardless of the release switch below.
//
//   requireAppAccess / requireAppAccessApi
//     The release-controlled app-access gate. Added for the v2
//     opening of Academy + Library to non-owner roster members.
//     Default CLOSED (flag OFF) means byte-identical to the owner
//     helpers for every caller. Flipping the flag opens the paths
//     named in src/lib/academy/access.ts isOpenedPath, scoped by
//     the viewer role (owner / lead / learner / denied).

import { notFound } from "next/navigation";
import { sessionEmail } from "./supabase/ssr";
import { appOpenToNonOwners, ownerEmails } from "./supabase/env";
import {
  resolveViewerRole,
  isOpenedPath,
  type ViewerRole,
} from "./academy/access";

export async function requireOwnerPage(): Promise<{ email: string }> {
  const email = await sessionEmail();
  if (!email) notFound();
  const owners = ownerEmails();
  if (!owners.has(email)) notFound();
  return { email };
}

export async function requireOwnerApi(): Promise<Response | { email: string }> {
  const email = await sessionEmail();
  if (!email) return new Response(null, { status: 401 });
  const owners = ownerEmails();
  if (!owners.has(email)) return new Response(null, { status: 404 });
  return { email };
}

/**
 * Page-level app-access gate.
 *
 * Flow:
 *   1. No session           -> notFound()
 *   2. Owner                -> return { email, role: "owner" }  (unchanged from today)
 *   3. Flag OFF             -> notFound()                       (byte-identical to requireOwnerPage)
 *   4. Resolve role; denied -> notFound()
 *   5. Path not opened      -> notFound()
 *   6. Return { email, role }
 *
 * `pathname` is the shell layout's view of the current URL (read via
 * the x-invoke-path / x-pathname header, same pattern layout.tsx
 * already uses). Pages that call this directly pass their own route
 * path (e.g. "/academy", "/academy/read/<id>").
 */
export async function requireAppAccess(
  pathname: string,
): Promise<{ email: string; role: ViewerRole }> {
  const email = await sessionEmail();
  if (!email) notFound();
  const owners = ownerEmails();
  if (owners.has(email)) {
    return { email, role: "owner" };
  }
  // Fail-closed: flag OFF -> same shape as requireOwnerPage.
  if (!appOpenToNonOwners()) {
    notFound();
  }
  const access = await resolveViewerRole(email);
  if (access.role === "denied") notFound();
  if (!isOpenedPath(pathname, access.role)) notFound();
  return { email, role: access.role };
}

/**
 * API-level app-access gate. Mirror of requireAppAccess but returns
 * a Response (401 unauth, 404 everything else) so API handlers can
 * `return` the result verbatim.
 *
 * `pathname` is the API route's semantic surface for the allowlist
 * check (callers pass a static route path, e.g. the whoami route
 * passes "/academy"). We do not derive it from the request URL so a
 * route can map several URL shapes to one opened surface and the
 * acceptance test can control the input.
 */
export async function requireAppAccessApi(
  pathname: string,
): Promise<Response | { email: string; role: ViewerRole }> {
  const email = await sessionEmail();
  if (!email) return new Response(null, { status: 401 });
  const owners = ownerEmails();
  if (owners.has(email)) {
    return { email, role: "owner" };
  }
  if (!appOpenToNonOwners()) {
    return new Response(null, { status: 404 });
  }
  const access = await resolveViewerRole(email);
  if (access.role === "denied") return new Response(null, { status: 404 });
  if (!isOpenedPath(pathname, access.role)) {
    return new Response(null, { status: 404 });
  }
  return { email, role: access.role };
}

// Accepts either `x-cron-secret: $CRON_SECRET` (manual curl, same
// shape as /api/intake) or `Authorization: Bearer $CRON_SECRET`
// (Vercel's own cron scheduler, which sets that header automatically
// when the CRON_SECRET env var is defined on the project).
export function isCronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;
  const custom = req.headers.get("x-cron-secret") ?? "";
  if (custom && custom === expected) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === expected;
  }
  return false;
}
