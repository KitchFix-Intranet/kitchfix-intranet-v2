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
// Response: { status, counts, note, coverage? }
//
// Cron behaviour (vercel.json schedules this on a 10-minute cadence):
//   The matcher proposes items from `link_status='none'`, moving them
//   to 'proposed'. It never writes 'confirmed' - Kevin does that from
//   the review queue. To stop burning Claude dollars on the long tail
//   of low-value unlinked items, the cron run exits BEFORE any Claude
//   call when cumulative covered dollars (confirmed + proposed) reach
//   MATCH_DOLLAR_TARGET_PCT of total food dollars. The cap is live and
//   recomputed each run, so new high-dollar items from nightly intake
//   re-open the gap and the cron picks them up again.
//
// Manual (owner-authed) runs skip the cap - they are debugging / drain
// pulls and Kevin may genuinely want to keep going past 80%.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { runMatcher } from "@/lib/matcher";
import { getMatcherCoverage, MATCH_DOLLAR_TARGET_PCT } from "@/lib/matcher/coverage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel's cron scheduler always issues GET, so the route exports both
// and shares a single handler. Owner-authed hits (the Admin page's
// "Run matcher" button) use POST; manual curl can use either.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
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

  // Cron-only cap check. Owner-authed runs bypass this so Kevin can
  // still drain past the target on purpose. If we are capped, exit
  // before touching Anthropic.
  //
  // pr_events.entity_id is uuid NOT NULL; the matcher's existing
  // 'matcher' events use this all-zeros sentinel when a run has no
  // row of its own to point at.
  const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";
  if (cron) {
    const cov = await getMatcherCoverage(client);
    if (cov.capMet) {
      // 10-minute cron x 144 runs/day of "nothing happened" would be
      // ~52K rows/year of ledger noise. Only log the capped run when
      // the state CHANGES - i.e. the previous matcher_cron_run was
      // uncapped. items_proposed is 0 on this path by construction, so
      // the state-transition check is the only gate.
      const { data: prev } = await client
        .from("pr_events")
        .select("after")
        .eq("entity_type", "matcher")
        .eq("kind", "matcher_cron_run")
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const prevCapMet =
        !!(prev?.after && typeof prev.after === "object" && (prev.after as { cap_met?: unknown }).cap_met === true);
      if (!prevCapMet) {
        await client.from("pr_events").insert({
          entity_type: "matcher",
          entity_id: SENTINEL_UUID,
          kind: "matcher_cron_run",
          actor: "cron",
          before: null,
          after: {
            cap_met: true,
            target_pct: MATCH_DOLLAR_TARGET_PCT,
            covered_usd: cov.coveredUsd,
            total_usd: cov.totalUsd,
            pct: Number(cov.pct.toFixed(2)),
            items_proposed: 0,
          },
        });
      }
      return NextResponse.json({
        status: "ok",
        note: `cap met: ${cov.pct.toFixed(2)}% covered of ${MATCH_DOLLAR_TARGET_PCT}% target`,
        counts: null,
        coverage: {
          total_usd: cov.totalUsd,
          covered_usd: cov.coveredUsd,
          pct: cov.pct,
          cap_met: true,
          target_pct: MATCH_DOLLAR_TARGET_PCT,
        },
      });
    }
  }

  const result = await runMatcher(client, {
    mode: limit ? "slice" : "full",
    limit,
    batchSize,
    logger: () => {},
  });

  // Cron runs log a per-run event with the new coverage figure.
  // Manual runs do not clutter the ledger with ad-hoc work.
  if (cron) {
    const after = await getMatcherCoverage(client);
    await client.from("pr_events").insert({
      entity_type: "matcher",
      entity_id: result.runId ?? SENTINEL_UUID,
      kind: "matcher_cron_run",
      actor: "cron",
      before: null,
      after: {
        cap_met: after.capMet,
        target_pct: MATCH_DOLLAR_TARGET_PCT,
        covered_usd: after.coveredUsd,
        total_usd: after.totalUsd,
        pct: Number(after.pct.toFixed(2)),
        items_proposed:
          (result.counts?.proposed_existing ?? 0) + (result.counts?.proposed_new ?? 0),
        status: result.status,
      },
    });
  }

  return NextResponse.json(result, {
    status: result.status === "ok" ? 200 : 500,
  });
}
