import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemEachWeight } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// N5: the item's own each_weight_lb. Set a number > 0 and <= 200, or
// null to clear. Numeric rules match the DB check constraint.
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; weightLb?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const itemId = body.itemId;
  if (typeof itemId !== "string" || itemId.length === 0) {
    return NextResponse.json({ error: "itemId required" }, { status: 400 });
  }

  let weightLb: number | null;
  if (body.weightLb === null) {
    weightLb = null;
  } else if (typeof body.weightLb === "number" && Number.isFinite(body.weightLb)) {
    if (body.weightLb <= 0 || body.weightLb > 200) {
      return NextResponse.json({ error: "weightLb must be greater than 0 and at most 200" }, { status: 400 });
    }
    weightLb = body.weightLb;
  } else {
    return NextResponse.json({ error: "weightLb must be a finite number or null" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemEachWeight(client, {
      itemId,
      weightLb,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
