// POST /api/academy/admin/cycles  -- create a draft cycle
//
// Body: {
//   label: string,
//   period_start: "YYYY-MM-DD",
//   period_end:   "YYYY-MM-DD",
//   audience_scope: object | null,
//   modules: Array<{ doc_id, obligation_key, doc_version, est_minutes?, sort_order? }>
// }
//
// Owner-gated. Validates the audience_scope via the engine's
// validateAudienceScope (resolves accounts/regions/worker_ids
// against live data) and refuses to write when the scope is bad.
// On success, inserts academy_cycles (status='draft', created_by =
// owner email) + academy_cycle_modules rows atomically through two
// writes. No requirement is written here - requirements are only
// materialised on publish, via the engine RPC.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import {
  validateAudienceScope,
  type AudienceScope,
} from "@/lib/academy/requirements";

export const dynamic = "force-dynamic";

interface CreateBody {
  label?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  audience_scope?: unknown;
  modules?: unknown;
}

interface ModuleIn {
  doc_id: string;
  obligation_key: string;
  doc_version: string | number | null;
  est_minutes?: number | null;
  sort_order?: number | null;
}

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function asString(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

export async function POST(request: NextRequest) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  const label = asString(body.label)?.trim() ?? "";
  const period_start = asString(body.period_start) ?? "";
  const period_end = asString(body.period_end) ?? "";
  if (!label) {
    return NextResponse.json({ error: "bad_request", detail: "label required" }, { status: 400 });
  }
  if (!isYmd(period_start) || !isYmd(period_end)) {
    return NextResponse.json(
      { error: "bad_request", detail: "period_start / period_end must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (period_end < period_start) {
    return NextResponse.json(
      { error: "bad_request", detail: "period_end must be on or after period_start" },
      { status: 400 },
    );
  }

  // audience_scope: null is valid (= all eligible); otherwise an
  // object. Reject arrays and primitives.
  let audienceScope: AudienceScope | null = null;
  if (body.audience_scope != null) {
    if (typeof body.audience_scope !== "object" || Array.isArray(body.audience_scope)) {
      return NextResponse.json(
        { error: "bad_request", detail: "audience_scope must be an object or null" },
        { status: 400 },
      );
    }
    audienceScope = body.audience_scope as AudienceScope;
  }

  // Modules in. Only shape-check here; the engine's publish time
  // runs the full obligation-exists check during planCyclePublish.
  const modulesIn = Array.isArray(body.modules) ? (body.modules as ModuleIn[]) : [];
  if (modulesIn.length === 0) {
    return NextResponse.json(
      { error: "bad_request", detail: "at least one module is required" },
      { status: 400 },
    );
  }
  for (const m of modulesIn) {
    if (!m || typeof m.doc_id !== "string" || typeof m.obligation_key !== "string") {
      return NextResponse.json(
        { error: "bad_request", detail: "every module needs doc_id and obligation_key" },
        { status: 400 },
      );
    }
  }

  const supa = serviceClient();

  // Validate audience_scope against live data. The engine helper
  // returns a list of errors; empty list = valid.
  const [acctQ, peopleQ] = await Promise.all([
    supa.from("accounts").select("team_key, region").neq("active", false),
    supa.from("people").select("worker_id").is("end_date", null),
  ]);
  if (acctQ.error) {
    console.error("[admin/cycles/create] accounts:", acctQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "accounts" }, { status: 500 });
  }
  if (peopleQ.error) {
    console.error("[admin/cycles/create] people:", peopleQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "people" }, { status: 500 });
  }
  const knownAccountKeys = new Set<string>();
  const knownRegions = new Set<string>();
  for (const a of (acctQ.data as Array<{ team_key: string | null; region: string | null }>) || []) {
    if (a.team_key) knownAccountKeys.add(a.team_key);
    if (a.region) knownRegions.add(a.region);
  }
  const activeWorkerIdsSet = new Set<string>(
    ((peopleQ.data as Array<{ worker_id: string }>) || []).map((p) => p.worker_id),
  );
  const scopeErrors = validateAudienceScope(audienceScope, {
    knownAccountKeys,
    knownRegions,
    activeWorkerIdsSet,
  });
  if (scopeErrors.length > 0) {
    return NextResponse.json(
      { error: "scope_invalid", details: scopeErrors },
      { status: 400 },
    );
  }

  // Insert the cycle row (draft). Returning cycle_id so we can wire
  // the modules immediately.
  const insCycle = await supa
    .from("academy_cycles")
    .insert({
      label,
      period_start,
      period_end,
      status: "draft",
      audience_scope: audienceScope,
      created_by: g.email,
    })
    .select("cycle_id, label, period_start, period_end, status")
    .single();
  if (insCycle.error) {
    console.error("[admin/cycles/create] cycle insert:", insCycle.error.message);
    return NextResponse.json(
      { error: "server_error", scope: "cycle_insert", detail: insCycle.error.message },
      { status: 500 },
    );
  }
  const cycleId = (insCycle.data as { cycle_id: string | number }).cycle_id;

  // Insert modules. If this fails, delete the cycle we just made so
  // the owner is not left staring at an empty draft that cannot
  // publish; this is a convenience, not an engine atomicity promise.
  const moduleRows = modulesIn.map((m, i) => ({
    cycle_id: cycleId,
    doc_id: m.doc_id,
    obligation_key: m.obligation_key,
    doc_version: m.doc_version ?? null,
    est_minutes: m.est_minutes ?? null,
    sort_order: m.sort_order ?? (i + 1) * 10,
  }));
  const insMods = await supa.from("academy_cycle_modules").insert(moduleRows);
  if (insMods.error) {
    console.error("[admin/cycles/create] modules insert:", insMods.error.message);
    await supa.from("academy_cycles").delete().eq("cycle_id", cycleId);
    return NextResponse.json(
      { error: "server_error", scope: "modules_insert", detail: insMods.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, cycle_id: cycleId, status: "draft" });
}
