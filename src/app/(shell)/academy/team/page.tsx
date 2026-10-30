// /academy/team - Team review for leads + owner. Gated by
// requireAppAccess("/academy/team") which the access gate reserves
// as lead-only (owner always passes). With the release flag OFF,
// the gate 404s every non-owner before the loader runs; only the
// owner reaches here today. When the flag flips on, a lead reaches
// their own team's roster + compliance.
//
// Read-only. No assign, no edit, no sign; no write route is
// reachable from this page.

import { requireAppAccess } from "@/lib/gate";
import { resolveViewerRole } from "@/lib/academy/access";
import { loadTeam } from "@/lib/academy/team";
import { TeamView } from "@/components/academy/team/TeamView";
import "@/components/academy/admin/admin.css";
import "@/components/academy/team/team.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  // Gate decides who is allowed. Owner shortcut makes this cheap;
  // leads also pass; everyone else -> notFound().
  const { email } = await requireAppAccess("/academy/team");

  // Resolve the viewer's role + lead signals once (owner shortcut
  // skips DB entirely; leads do a few point reads). The loader uses
  // the role + leadReasons to decide the scope. This is scope
  // selection, not re-gating.
  const viewer = await resolveViewerRole(email);

  const sp = await searchParams;
  const rawScope = Array.isArray(sp.scope) ? sp.scope[0] : sp.scope;

  const view = await loadTeam({ viewer, scope: rawScope || "all" });

  return <TeamView view={view} />;
}
