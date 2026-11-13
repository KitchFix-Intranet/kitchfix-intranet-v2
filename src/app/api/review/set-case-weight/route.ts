import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// M1: the item-level case weight override. When set it describes the
// case's total weight in lb, replacing the ingredient's measures for
// pricing THIS ITEM ONLY (§2.2 of the prompt).
//
//   { itemId, caseWeightLb: number }  - set
//   { itemId, caseWeightLb: null }    - clear
//
// Range: > 0 and <= 5000. Quoted from migration 0019
// (`pr_vendor_items_case_weight_range`); the route checks it so the
// user gets a sentence instead of a 500, and the DB constraint is the
// backstop. No second, tighter bound is added in the route (amendment
// 1b: one rule, one place).
//
// Does NOT clear pr_vendor_items.each_measure_qty/uom (amendment 1a).

const RANGE_MAX = 5000;

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const actorEmail = (gate as { email: string }).email;

  let body: { itemId?: unknown; caseWeightLb?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const itemId = typeof body.itemId === "string" ? body.itemId : null;
  if (!itemId) {
    return NextResponse.json({ error: "itemId required" }, { status: 400 });
  }

  let caseWeightLb: number | null;
  if (body.caseWeightLb === null) {
    caseWeightLb = null;
  } else if (typeof body.caseWeightLb === "number" && Number.isFinite(body.caseWeightLb)) {
    // DB: pr_vendor_items_case_weight_range (case_weight_lb > 0 and <= 5000).
    if (body.caseWeightLb <= 0 || body.caseWeightLb > RANGE_MAX) {
      return NextResponse.json(
        { error: `caseWeightLb must be greater than 0 and at most ${RANGE_MAX}` },
        { status: 400 },
      );
    }
    caseWeightLb = body.caseWeightLb;
  } else {
    return NextResponse.json({ error: "caseWeightLb must be a finite number or null" }, { status: 400 });
  }

  const supa = serviceClient();

  const { data: cur, error: curErr } = await supa
    .from("pr_vendor_items")
    .select("id,case_weight_lb")
    .eq("id", itemId)
    .maybeSingle();
  if (curErr) return NextResponse.json({ error: curErr.message }, { status: 500 });
  if (!cur) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const before = (cur as { case_weight_lb: number | null }).case_weight_lb;
  const beforeN = before == null ? null : Number(before);
  if (beforeN === caseWeightLb) return NextResponse.json({ ok: true });

  const nowIso = new Date().toISOString();
  const { error: upErr } = await supa
    .from("pr_vendor_items")
    .update({
      case_weight_lb: caseWeightLb,
      case_weight_set_by: caseWeightLb == null ? null : actorEmail,
      case_weight_set_at: caseWeightLb == null ? null : nowIso,
    })
    .eq("id", itemId);
  if (upErr) {
    // Pre-0019 the column does not exist; surface a clear message.
    return NextResponse.json({ error: upErr.message }, { status: 400 });
  }

  const { error: evErr } = await supa.from("pr_events").insert({
    entity_type: "vendor_item",
    entity_id: itemId,
    kind: "vendor_item_case_weight_set",
    before: { case_weight_lb: beforeN },
    after: { case_weight_lb: caseWeightLb },
    actor: actorEmail,
  });
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, caseWeightLb });
}
