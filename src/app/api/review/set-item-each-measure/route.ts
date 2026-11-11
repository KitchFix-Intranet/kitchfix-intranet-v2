import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemEachMeasure } from "@/lib/reviewWrites";
import { DIM_BY_UOM, TO_BASE } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

// N6: the vendor item's own each measure when its each is a different
// size than the master's. Weight or volume, qty > 0 and <= 100,000.
// Converted sanity bounds: 200 lb / 55 gal.
const MAX_LB = 200;
const MAX_GAL = 55;

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; qty?: unknown; uom?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const itemId = body.itemId;
  if (typeof itemId !== "string" || itemId.length === 0) {
    return NextResponse.json({ error: "itemId required" }, { status: 400 });
  }

  let qty: number | null;
  if (body.qty === null) {
    qty = null;
  } else if (typeof body.qty === "number" && Number.isFinite(body.qty)) {
    if (body.qty <= 0 || body.qty > 100000) {
      return NextResponse.json({ error: "qty must be greater than 0 and at most 100000" }, { status: 400 });
    }
    qty = body.qty;
  } else {
    return NextResponse.json({ error: "qty must be a finite number or null" }, { status: 400 });
  }

  let uom: string | null;
  if (qty == null) {
    uom = null;
  } else {
    if (typeof body.uom !== "string" || body.uom.length === 0) {
      return NextResponse.json({ error: "uom required" }, { status: 400 });
    }
    const u = body.uom.toUpperCase();
    const dim = DIM_BY_UOM[u];
    const factor = TO_BASE[u];
    if (dim == null || factor == null || (dim !== "weight" && dim !== "volume")) {
      return NextResponse.json({ error: "uom must be a weight or volume unit" }, { status: 400 });
    }
    if (dim === "weight") {
      const asLb = qty * factor;
      if (asLb > MAX_LB) return NextResponse.json({ error: `measure above ${MAX_LB} lb is implausible for one each` }, { status: 400 });
    } else {
      const asFloz = qty * factor;
      const asGal = asFloz / TO_BASE["GAL"];
      if (asGal > MAX_GAL) return NextResponse.json({ error: `measure above ${MAX_GAL} gal is implausible for one each` }, { status: 400 });
    }
    uom = u;
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemEachMeasure(client, {
      itemId,
      qty,
      uom,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
