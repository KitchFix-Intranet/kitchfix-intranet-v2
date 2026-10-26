// POST /api/match
//
// Dual-auth, same shape as /api/intake:
//   - x-cron-secret: CRON_SECRET  OR
//   - curator session via requireOwnerApi
//
// Body / query:
//   ?limit=500   - optional slice (process the top N dollar-ordered items)
//   ?batch=35    - optional per-model-call batch size (5..60)
//
// Response: { status, counts, note }

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { runMatcher } from "@/lib/matcher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cron = isCronAuthorized(req);
  if (!cron) {
    const gate = await requireOwnerApi();
    if (gate instanceof Response) return gate;
  }

  const url = req.nextUrl;
  const limitParam = url.searchParams.get("limit");
  const batchParam = url.searchParams.get("batch");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10)) : undefined;
  const batchSize = batchParam ? Math.max(5, Math.min(60, parseInt(batchParam, 10))) : undefined;

  const client = serviceClient();
  const result = await runMatcher(client, {
    mode: limit ? "slice" : "full",
    limit,
    batchSize,
    logger: () => {},
  });

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 500,
  });
}
