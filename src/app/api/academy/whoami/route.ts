// /api/academy/whoami
//
// Debug / gate route. Returns the Academy identity resolved for the
// signed-in owner, plus the standing-card boolean and the eligible-
// person count that produced it.
//
// Gate (v2): requireAppAccessApi("/academy"). Flag OFF -> only
// owner reaches here; flag ON -> owner, lead, learner (the gate's
// path allowlist opens /academy to all three). Unauth gets 401
// from the proxy; non-roster gets 404.

import { NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import {
  resolveAcademyIdentity,
  eligibleCountInScope,
} from "@/lib/academy/identity";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireAppAccessApi("/academy");
  if (g instanceof Response) return g;

  const supa = serviceClient();

  let identity;
  try {
    identity = await resolveAcademyIdentity(g.email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/whoami] resolveIdentity threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "resolve" }, { status: 500 });
  }

  if (!identity) {
    return NextResponse.json({
      ok: true,
      identity: null,
      canSeeStandingCard: false,
      canSeeHourlyRoster: false,
      eligibleCountInScope: { salaried: 0, hourly: 0, total: 0 },
      resolvedFor: g.email,
      reason: "no active roster row for this email",
    });
  }

  let counts;
  try {
    counts = await eligibleCountInScope(identity, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/whoami] scope math threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "scope" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    resolvedFor: g.email,
    identity,
    canSeeStandingCard: counts.salaried > 0,
    canSeeHourlyRoster: counts.hourly > 0,
    eligibleCountInScope: counts,
  });
}
