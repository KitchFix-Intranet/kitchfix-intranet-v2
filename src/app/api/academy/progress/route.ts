// /api/academy/progress
//
// Body: { requirementId, sectionsSeen: string[], timeSpentSeconds }
//
// Save + resume support. UPSERTs the mutable scratch row on
// academy_module_progress so the next fetch of /api/academy/module
// knows which step to mount at.
//
// Merge semantics:
//   - sections_seen grows monotonically. The server takes the UNION
//     of the existing row's array + the incoming array.
//   - time_spent_seconds takes the MAX of existing + incoming.
//   - last_seen_at set to NOW on every request.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "@/lib/academy/identity";
import { UUID_RE } from "@/lib/academy/module";

export const dynamic = "force-dynamic";

interface ProgressBody {
  requirementId?: unknown;
  sectionsSeen?: unknown;
  timeSpentSeconds?: unknown;
}

export async function POST(request: NextRequest) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  let body: ProgressBody;
  try {
    body = (await request.json()) as ProgressBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 }
    );
  }
  const requirementId = body.requirementId;
  const sectionsSeen = Array.isArray(body.sectionsSeen)
    ? body.sectionsSeen.filter((s): s is string => typeof s === "string")
    : [];
  const timeSpentRaw = body.timeSpentSeconds;
  const timeSpentSeconds = Number.isFinite(Number(timeSpentRaw))
    ? Math.max(0, Math.floor(Number(timeSpentRaw)))
    : 0;
  if (typeof requirementId !== "string" || !UUID_RE.test(requirementId)) {
    return NextResponse.json(
      { error: "bad_request", detail: "requirementId must be a UUID" },
      { status: 400 }
    );
  }

  const supa = serviceClient();

  let identity;
  try {
    identity = await resolveAcademyIdentity(g.email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/progress] resolve threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "identity" }, { status: 500 });
  }
  if (!identity) {
    return NextResponse.json({ error: "no_roster_row" }, { status: 404 });
  }

  const reqQ = await supa
    .from("academy_requirements")
    .select("requirement_id, worker_id, waived_at")
    .eq("requirement_id", requirementId)
    .eq("worker_id", identity.workerId)
    .maybeSingle();
  if (reqQ.error) {
    console.error("[api/academy/progress] requirement lookup:", reqQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "requirement" }, { status: 500 });
  }
  if (!reqQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const req = reqQ.data as { requirement_id: string; worker_id: string; waived_at: string | null };
  if (req.waived_at != null) {
    return NextResponse.json(
      { error: "waived", detail: "requirement is waived" },
      { status: 409 }
    );
  }

  const existQ = await supa
    .from("academy_module_progress")
    .select(
      "worker_id, requirement_id, sections_seen, started_at, last_seen_at, time_spent_seconds"
    )
    .eq("worker_id", identity.workerId)
    .eq("requirement_id", requirementId)
    .maybeSingle();
  if (existQ.error) {
    console.error("[api/academy/progress] existing lookup:", existQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "existing" }, { status: 500 });
  }
  type ProgressRow = {
    worker_id: string;
    requirement_id: string;
    sections_seen: unknown;
    started_at: string | null;
    last_seen_at: string | null;
    time_spent_seconds: number | null;
  };
  const existing = existQ.data as ProgressRow | null;

  const existingSeen = Array.isArray(existing?.sections_seen)
    ? (existing!.sections_seen as string[])
    : [];
  const mergedSeen = [...new Set([...existingSeen, ...sectionsSeen])];
  const mergedTime = Math.max(existing?.time_spent_seconds ?? 0, timeSpentSeconds);
  const nowIso = new Date().toISOString();

  let writeQ;
  if (existing) {
    writeQ = await supa
      .from("academy_module_progress")
      .update({
        sections_seen: mergedSeen,
        last_seen_at: nowIso,
        time_spent_seconds: mergedTime,
      })
      .eq("worker_id", identity.workerId)
      .eq("requirement_id", requirementId)
      .select(
        "worker_id, requirement_id, sections_seen, started_at, last_seen_at, time_spent_seconds"
      )
      .single();
  } else {
    writeQ = await supa
      .from("academy_module_progress")
      .insert({
        worker_id: identity.workerId,
        requirement_id: requirementId,
        sections_seen: mergedSeen,
        started_at: nowIso,
        last_seen_at: nowIso,
        time_spent_seconds: mergedTime,
      })
      .select(
        "worker_id, requirement_id, sections_seen, started_at, last_seen_at, time_spent_seconds"
      )
      .single();
  }
  if (writeQ.error) {
    console.error("[api/academy/progress] write:", writeQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "write" }, { status: 500 });
  }

  const data = writeQ.data as ProgressRow;
  return NextResponse.json({
    ok: true,
    progress: {
      sections_seen: data.sections_seen,
      started_at: data.started_at,
      last_seen_at: data.last_seen_at,
      time_spent_seconds: data.time_spent_seconds,
    },
  });
}
