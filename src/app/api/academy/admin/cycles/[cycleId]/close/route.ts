// POST /api/academy/admin/cycles/[cycleId]/close
//
// Owner-gated. Closes a published cycle - sets status='closed' and
// stamps closed_at. Issued requirements are NOT touched; this just
// retires the cycle window. A draft cycle cannot be "closed" (it
// never opened); a published cycle can, a closed cycle is a no-op
// 409.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

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
  const curQ = await supa
    .from("academy_cycles")
    .select("cycle_id, status")
    .eq("cycle_id", key)
    .maybeSingle();
  if (curQ.error) {
    console.error("[admin/cycles/close] lookup:", curQ.error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!curQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const current = (curQ.data as { status: string }).status;
  if (current === "closed") {
    return NextResponse.json({ error: "already_closed" }, { status: 409 });
  }
  if (current !== "published") {
    return NextResponse.json(
      { error: "not_published", detail: `cycle is ${current}; only published cycles can close` },
      { status: 409 },
    );
  }

  const upd = await supa
    .from("academy_cycles")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("cycle_id", key)
    .select("cycle_id, status, closed_at")
    .single();
  if (upd.error) {
    console.error("[admin/cycles/close] update:", upd.error.message);
    return NextResponse.json(
      { error: "server_error", detail: upd.error.message },
      { status: 500 },
    );
  }

  // Rely on g.email as the actor; the data model doesn't carry a
  // closed_by today, so we only stamp closed_at. If a closed_by is
  // added later this returns the row for the audit trail elsewhere.
  void g.email;

  return NextResponse.json({ ok: true, cycle: upd.data });
}
