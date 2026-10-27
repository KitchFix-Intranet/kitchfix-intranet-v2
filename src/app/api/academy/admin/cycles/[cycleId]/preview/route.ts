// POST /api/academy/admin/cycles/[cycleId]/preview
//
// Owner-gated READ-ONLY. Wraps planCyclePublish - returns the engine's
// plan report (people affected, breakdown, refuse reasons). No row
// in academy_requirements is written here; the publish route is the
// only path that writes.
//
// Why POST (not GET): keeps the plan call off the browser's history
// and prevents accidental caching of a changing plan. It's a probe
// from the admin, not a static resource.

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { planCyclePublish } from "@/lib/academy/requirements";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ cycleId: string }> },
) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  const { cycleId } = await ctx.params;
  const asNumber = Number(cycleId);
  const key: string | number = Number.isFinite(asNumber) ? asNumber : cycleId;

  const supa = serviceClient();
  try {
    // Force=true so the plan can also run against a published cycle
    // (reporting-only). The route refuses to publish a non-draft
    // elsewhere; here we just want the plan output.
    const plan = await planCyclePublish(supa, key, { force: true });
    return NextResponse.json({ ok: true, cycle_id: key, plan });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/cycles/preview]", msg);
    return NextResponse.json(
      { error: "preview_failed", detail: msg },
      { status: 400 },
    );
  }
}
