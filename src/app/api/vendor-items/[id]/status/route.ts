import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

const ALLOWED = new Set(["active", "archived", "one_off", "not_food", "resale"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let body: { status?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  const next = body.status;
  if (!next || !ALLOWED.has(next)) return new NextResponse("invalid status", { status: 400 });

  const client = serviceClient();

  const { data: cur, error: readErr } = await client
    .from("pr_vendor_items")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!cur) return new NextResponse("not found", { status: 404 });

  const { error } = await client
    .from("pr_vendor_items")
    .update({ status: next })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await client.from("pr_events").insert({
    entity_type: "vendor_item",
    entity_id: id,
    kind: "status_changed",
    before: { status: cur.status },
    after: { status: next },
    actor: gate.email,
    note: `${cur.status} -> ${next}`,
  });

  return NextResponse.json({ ok: true, status: next });
}
