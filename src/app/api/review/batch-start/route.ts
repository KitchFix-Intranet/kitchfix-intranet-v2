// T5b round 2 item 2: one run at a time. The route claims a row
// in pr_events BEFORE calling runMatcher, waits for any racing
// claim to land, then goes ahead only if its own claim is the
// earliest live one. A loser cancels its own claim so the next
// press is free to run. Two or five requests that arrive together
// end up with ONE matcher call; a request that arrives during a
// live run calls it zero times. See src/lib/matcher/claim.ts for
// the claim-and-check logic and scripts/t5b_batch_start_lock_proof.mjs
// for the proof that imports the real code (not a copy).
//
// Why two requests cannot both win, in three sentences:
//
// 1. Both requests pass the preflight "is a run live", then both
//    INSERT their own ai_match_claim row - the row's `at` comes
//    from Postgres so the two writes are ordered by one clock.
// 2. Both requests then wait a fixed settle window and re-read
//    the claims in the window, so each sees BOTH its own row and
//    the other's.
// 3. The predicate picks the earliest live claim by (at, id) as
//    the winner - a deterministic function of what each request
//    then sees, so both decide the same winner; the loser
//    cancels its own row.
//
// The matcher is never started from this file during tests.
// scripts/t5b_batch_start_lock_proof.mjs stands up an in-memory
// store and an injected matcher so the proof exercises every case
// (two concurrent, five concurrent, during a live run, after a
// finished run, after a refused claim, after a dead start >= 330 s
// old) without calling the real matcher.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireOwnerApi } from "@/lib/gate";
import { runMatcher } from "@/lib/matcher";
import { makeEventsStore, tryClaim } from "@/lib/matcher/claim";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// T5b ruling 6: stated once, mirrored in BatchRunControl. Any other
// size is refused with the same 400 as a malformed body.
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
    // Empty / malformed body: fall through with no size (treated as
    // missing below).
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
  const outcome = await tryClaim(makeEventsStore(client), {
    size,
    actor: gate.email,
  });
  if (!outcome.won) {
    return NextResponse.json(
      {
        status: "in_progress",
        reason: "A batch is already running. Nothing new was started.",
      },
      { status: 409 },
    );
  }

  // We won the claim. runMatcher writes its own ai_match_run_started
  // and ai_match_run rows; /api/match is untouched.
  const result = await runMatcher(client, {
    mode: "slice",
    limit: size,
    logger: () => {},
  });

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 500,
  });
}
