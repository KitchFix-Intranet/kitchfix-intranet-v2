// POST /api/academy/admin/cycles/[cycleId]/publish
//
// Owner-gated. Issues the cycle's assignments by routing through the
// engine's applyCyclePublish (which calls the publish_cycle_atomic
// RPC - the one and only writer into academy_requirements for
// cycle-source rows). The route NEVER inserts into
// academy_requirements directly; eligibility, idempotency and the
// cycle status flip all live inside the engine + RPC.
//
// Shape:
//   1. requireOwnerApi() (401/404 if not an owner).
//   2. Confirm the cycle is still status='draft' before planning;
//      a published cycle cannot be re-published.
//   3. Re-run planCyclePublish server-side so the plan is fresh and
//      cannot be a stale client payload.
//   4. If the plan would refuse (wouldRefuseApply), reject here;
//      applyCyclePublish would throw anyway.
//   5. applyCyclePublish - the RPC does the atomic flip + inserts.
//   6. Return the engine's result.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import {
  applyCyclePublish,
  planCyclePublish,
  type CyclePublishPlan,
} from "@/lib/academy/requirements";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ cycleId: string }> },
) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  const { cycleId } = await ctx.params;
  const asNumber = Number(cycleId);
  const key: string | number = Number.isFinite(asNumber) ? asNumber : cycleId;

  const supa = serviceClient();

  // Gate 1: cycle must be draft.
  const statusQ = await supa
    .from("academy_cycles")
    .select("cycle_id, status")
    .eq("cycle_id", key)
    .maybeSingle();
  if (statusQ.error) {
    console.error("[admin/cycles/publish] status lookup:", statusQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "status" }, { status: 500 });
  }
  if (!statusQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const current = (statusQ.data as { status: string }).status;
  if (current !== "draft") {
    return NextResponse.json(
      {
        error: "cycle_not_draft",
        detail: `cycle is already ${current}; publish only accepts draft`,
      },
      { status: 409 },
    );
  }

  // Gate 2: fresh plan server-side. Never trust a client-posted plan.
  let plan: CyclePublishPlan;
  try {
    plan = await planCyclePublish(supa, key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/cycles/publish] plan threw:", msg);
    return NextResponse.json({ error: "plan_failed", detail: msg }, { status: 400 });
  }
  const report = plan.report as {
    wouldRefuseApply?: boolean;
    refuseReasons?: string[];
    totalRequirements?: number;
  };
  if (report?.wouldRefuseApply) {
    return NextResponse.json(
      {
        error: "plan_refuses",
        detail: "plan refuses to publish",
        reasons: report.refuseReasons ?? [],
      },
      { status: 409 },
    );
  }

  // Apply - RPC does the atomic status flip + insert.
  try {
    const result = await applyCyclePublish(supa, key, g.email, plan);
    return NextResponse.json({
      ok: true,
      cycle_id: key,
      inserted: report?.totalRequirements ?? plan.rows.length,
      rpc_result: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/cycles/publish] apply threw:", msg);
    return NextResponse.json({ error: "publish_failed", detail: msg }, { status: 500 });
  }
}
