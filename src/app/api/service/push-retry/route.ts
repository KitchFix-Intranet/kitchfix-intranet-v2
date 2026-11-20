// Push-retry cron handler.
//
// Vercel's cron (every 10 minutes per vercel.json) hits this
// endpoint. One manual trigger via an owner session is also
// supported (same dual-auth shape as /api/match).
//
// The handler delegates to findAndAttemptDuePushRows from the
// submit library, which implements the ten-minute / six-try
// cadence, the compare-and-swap claim, and the give-up notice.
// This file is only the cron plumbing.

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { findAndAttemptDuePushRows } from "@/lib/sc/submit/push";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<Response> {
  if (!isCronAuthorized(req)) {
    const gate = await requireOwnerApi();
    if (gate instanceof Response) return gate;
  }

  const results = await findAndAttemptDuePushRows();
  const counts = { attempted: results.length, done: 0, failed: 0, skipped: 0, gave_up: 0, errored: 0 };
  for (const r of results) {
    const state = r.result.state;
    if (state === "pushed" || state === "awaiting_pair_close" || state === "no_billable_actuals" || state === "already_invoiced") counts.done += 1;
    else if (state === "failed") counts.failed += 1;
    else if (state === "gave_up") counts.gave_up += 1;
    else if (state === "skipped") counts.skipped += 1;
    else if (state === "errored") counts.errored += 1;
  }
  return NextResponse.json({ ok: true, counts });
}
