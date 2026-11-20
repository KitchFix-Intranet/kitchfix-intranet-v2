// T5b item 4 (ruling 5): a sibling route that kicks off a matcher
// batch from the Review-queue page without touching /api/match or its
// cron semantics. Owner-only. Reads pr_events for an in-progress
// `ai_match_run_started` row (no matching `ai_match_run` row within
// the 330 s freshness window) and refuses to start a second run, from
// this tab or another. Writes its own guard row before calling
// runMatcher from the library so two concurrent presses start at most
// one run.
//
// Sizes are 50 / 100 / 200 (ruling 6). Any other size is rejected
// outright. At the measured ~28 seconds per 35-item batch (ruling 3),
// 200 items sit inside the 300 s cap with headroom; 250 and 500 do
// not. The route exports the same maxDuration as /api/match so the
// browser fetch can hold the connection for the full run.
//
// The matcher is never started here from a test. See
// scripts/t5b_batch_start_lock_proof.mjs: the lock is covered with
// an injected runMatcher stub.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireOwnerApi } from "@/lib/gate";
import { runMatcher } from "@/lib/matcher";
import { isBatchInProgress } from "@/lib/matcher/lock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_SIZES = [50, 100, 200] as const;
type AllowedSize = (typeof ALLOWED_SIZES)[number];

type StartBody = { size?: number };

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: StartBody = {};
  try {
    body = (await req.json()) as StartBody;
  } catch {
    // An empty POST is fine; default size applies. A malformed body
    // (not JSON) also lands here - treat as empty.
  }
  const sizeRaw = body.size;
  const size: AllowedSize | null =
    typeof sizeRaw === "number" && (ALLOWED_SIZES as readonly number[]).includes(sizeRaw)
      ? (sizeRaw as AllowedSize)
      : null;
  if (size == null) {
    return NextResponse.json(
      {
        status: "rejected",
        reason: "size must be one of 50, 100 or 200.",
      },
      { status: 400 },
    );
  }

  const client = serviceClient();

  // Ruling 7: decide "in progress" from the newest ai_match_run_started
  // row + the newest ai_match_run row. The started row is only a lock
  // if it is YOUNGER than BATCH_FRESH_MS AND no ai_match_run row
  // followed it. Old dead starts (there were 21 on production as of
  // the memo) never block. The two selects read one row each.
  const nowMs = Date.now();
  const [startRes, endRes] = await Promise.all([
    client
      .from("pr_events")
      .select("at")
      .eq("entity_type", "matcher")
      .eq("kind", "ai_match_run_started")
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("pr_events")
      .select("at")
      .eq("entity_type", "matcher")
      .eq("kind", "ai_match_run")
      .order("at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const startAt = (startRes.data?.at as string | undefined) ?? null;
  const endAt = (endRes.data?.at as string | undefined) ?? null;
  const startMs = startAt ? Date.parse(startAt) : null;
  const inProgress = isBatchInProgress(startAt, endAt, nowMs);
  if (inProgress) {
    return NextResponse.json(
      {
        status: "in_progress",
        reason: "A batch is already running. Nothing new was started.",
        startedAt: startAt,
      },
      { status: 409 },
    );
  }

  // Ruling 7 continued: two near-simultaneous presses must start at
  // most one run. runMatcher writes its own ai_match_run_started row
  // at the top of its loop (matcher.ts:368). We re-read the newest
  // started row AFTER a short cooperative yield to catch a near-race
  // - the loser sees the winner's started row within one tick of its
  // own check. The combined "started within 500 ms of now"
  // short-circuit covers the one case the unordered Promise.all above
  // can miss. 500 ms is well under BATCH_FRESH_MS and under the time
  // it takes to drive from "click" to "handler" at any speed.
  await new Promise<void>((r) => setTimeout(r, 50));
  const raceRes = await client
    .from("pr_events")
    .select("at")
    .eq("entity_type", "matcher")
    .eq("kind", "ai_match_run_started")
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raceAt = (raceRes.data?.at as string | undefined) ?? null;
  const raceMs = raceAt ? Date.parse(raceAt) : null;
  if (
    raceMs != null &&
    (startMs == null || raceMs > startMs) &&
    nowMs - raceMs < 500
  ) {
    return NextResponse.json(
      {
        status: "in_progress",
        reason: "A batch is already running. Nothing new was started.",
        startedAt: raceAt,
      },
      { status: 409 },
    );
  }

  // Ruling 5: no change to /api/match or its handler. We call the
  // library function directly, in slice mode, with the chosen size
  // as the limit. runMatcher writes ai_match_run_started /
  // ai_match_run itself, so the next caller's lock check sees this
  // one.
  const result = await runMatcher(client, {
    mode: "slice",
    limit: size,
    logger: () => {},
  });

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 500,
  });
}

// The client's BatchRunControl declares the same 50 / 100 / 200 set;
// Next's route.ts restricts non-handler exports, so the shared
// constant lives inline in both places with a one-line note each.
