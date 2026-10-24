// POST /api/intake
//
// Two authorized paths:
//   1. Cron / curl with header x-cron-secret: CRON_SECRET.
//   2. A signed-in curator session.
//
// Any other request is 401 (missing session) or 404 (session but not owner).
// Responds with { status, runId, counts, note } so the Overview can show
// the result verbatim.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { runIntake, type IntakeMode } from "@/lib/intake";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const authedByCron = isCronAuthorized(req);
  if (!authedByCron) {
    const gate = await requireOwnerApi();
    if (gate instanceof Response) return gate;
  }

  const url = req.nextUrl;
  const modeParam = url.searchParams.get("mode");
  const mode: IntakeMode = modeParam === "incremental" ? "incremental" : "full";

  const client = serviceClient();
  const result = await runIntake(client, mode, () => {});

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 500,
  });
}
