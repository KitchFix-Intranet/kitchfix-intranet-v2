// POST   /api/academy/admin/people/region-leads  -- assign (upsert) a lead
// DELETE /api/academy/admin/people/region-leads  -- unassign a lead
//
// Owner-gated. The ONLY write E3 ships. Writes land exactly on
// `academy_region_leads` { region, email, assigned_by, assigned_at };
// `assigned_by` is set to the owner's email, `assigned_at` to now().
//
// Validation on POST:
//   - region must be present in the canonical list (distinct non-null
//     accounts.region across active accounts). Free-text regions are
//     refused.
//   - email must belong to an ACTIVE people row (status='ACTIVE'
//     with a non-null work_email). We never attach a lead to someone
//     who is not on the roster.
//
// Validation on DELETE:
//   - region + email both required; no fuzzy match. If no row exists
//     for the pair we return ok anyway (idempotent delete).

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

interface AssignBody {
  region?: unknown;
  email?: unknown;
}

function asString(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

function normEmail(x: string): string {
  return x.toLowerCase();
}

async function loadCanonicalRegions(
  supa: ReturnType<typeof serviceClient>,
): Promise<Set<string>> {
  const q = await supa.from("accounts").select("region").neq("active", false);
  if (q.error) throw new Error(`accounts: ${q.error.message}`);
  const out = new Set<string>();
  for (const r of (q.data as Array<{ region: string | null }>) || []) {
    if (r.region) out.add(r.region);
  }
  return out;
}

export async function POST(request: NextRequest) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  let body: AssignBody;
  try {
    body = (await request.json()) as AssignBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  const region = asString(body.region);
  const emailRaw = asString(body.email);
  if (!region || !emailRaw) {
    return NextResponse.json(
      { error: "bad_request", detail: "region and email are required" },
      { status: 400 },
    );
  }
  const email = normEmail(emailRaw);
  const supa = serviceClient();

  // Validate region against the canonical list.
  const regions = await loadCanonicalRegions(supa);
  if (!regions.has(region)) {
    return NextResponse.json(
      {
        error: "scope_invalid",
        detail: `region "${region}" is not in the canonical list (accounts.region)`,
      },
      { status: 400 },
    );
  }

  // Validate email belongs to an active person on the roster.
  const personQ = await supa
    .from("people")
    .select("worker_id, work_email, status")
    .eq("status", "ACTIVE")
    .ilike("work_email", email);
  if (personQ.error) {
    console.error("[admin/people/region-leads] person check:", personQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "person" }, { status: 500 });
  }
  const rows = (personQ.data as Array<{ worker_id: string; work_email: string | null }>) || [];
  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: "scope_invalid",
        detail: `email "${email}" is not on the active roster`,
      },
      { status: 400 },
    );
  }
  // Note: identity.ts treats >1 active rows for one email as a defect
  // and declines, but here we only need to confirm membership. Any
  // number >=1 is sufficient to prove the email is a real active
  // work_email; we do not block assignment on the duplicate defect
  // because the sign-in path would already surface it on login.

  // Upsert the lead row. academy_region_leads is keyed on (region)
  // conceptually; we delete-then-insert so a region can only have
  // one lead at a time without needing a DB-level unique constraint
  // (the schema we observed does not advertise one explicitly).
  // One region, one lead: assigning replaces.
  const del = await supa.from("academy_region_leads").delete().eq("region", region);
  if (del.error) {
    console.error("[admin/people/region-leads] delete-prev:", del.error.message);
    return NextResponse.json(
      { error: "server_error", scope: "clear_prev", detail: del.error.message },
      { status: 500 },
    );
  }
  const ins = await supa
    .from("academy_region_leads")
    .insert({
      region,
      email,
      assigned_by: g.email,
      assigned_at: new Date().toISOString(),
    })
    .select("region, email, assigned_by, assigned_at")
    .single();
  if (ins.error) {
    console.error("[admin/people/region-leads] insert:", ins.error.message);
    return NextResponse.json(
      { error: "server_error", scope: "insert", detail: ins.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, row: ins.data });
}

export async function DELETE(request: NextRequest) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;
  // Silence `g` is unused warning while we still want the gate's
  // identity for future logging.
  void g;

  const url = new URL(request.url);
  const region = asString(url.searchParams.get("region"));
  const emailRaw = asString(url.searchParams.get("email"));
  if (!region || !emailRaw) {
    return NextResponse.json(
      { error: "bad_request", detail: "region and email are required" },
      { status: 400 },
    );
  }
  const email = normEmail(emailRaw);

  const supa = serviceClient();
  const del = await supa
    .from("academy_region_leads")
    .delete()
    .eq("region", region)
    .ilike("email", email);
  if (del.error) {
    console.error("[admin/people/region-leads] delete:", del.error.message);
    return NextResponse.json(
      { error: "server_error", scope: "delete", detail: del.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, region, email });
}
