// POST /api/review/set-price-override
//
// Direct per-base price override. Separate from set-pack-override:
// this fixes the SYMPTOM (the number is wrong) without claiming the
// pack is human-set. See setVendorItemPriceOverride in
// src/lib/reviewWrites.ts for the backfill-durability caveat.
//
// Body: { itemId, perBase, baseUom, reason }
//   perBase - positive finite number IN THE TYPED UNIT
//   baseUom - any weight uom (LB, OZ, G, KG), any volume uom
//             (FLOZ, PT, QT, GAL, L, ML), or EA (case-insensitive)
//   reason  - non-empty; a hand-set price with no stated reason is
//             how a catalog rots quietly.
//
// N6: the client can type in any weight or volume unit. The route
// converts the typed value to the dimension's base (LB / FLOZ / EA) via
// TO_BASE before calling the writer, so nothing downstream changes -
// the stored shape stays { per_base, base_uom in {LB,FLOZ,EA} } exactly
// as it is today. The event row records BOTH the typed and the stored
// value so "$4 / gal" is recoverable from history.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemPriceOverride } from "@/lib/reviewWrites";
import { DIM_BY_UOM, TO_BASE, BASE_BY_DIM } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; perBase?: unknown; baseUom?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });

  const typedPerBase = Number(body.perBase);
  if (!Number.isFinite(typedPerBase) || typedPerBase <= 0) {
    return NextResponse.json({ error: "perBase must be a positive finite number" }, { status: 400 });
  }

  const typedUom = typeof body.baseUom === "string" ? body.baseUom.trim().toUpperCase() : "";
  const dim = DIM_BY_UOM[typedUom];
  const factor = TO_BASE[typedUom];
  if (!dim || factor == null) {
    return NextResponse.json({ error: "baseUom must be a weight, volume, or EA unit" }, { status: 400 });
  }
  // Resolve the stored base: weight -> LB, volume -> FLOZ, count -> EA.
  const storedBase = BASE_BY_DIM[dim];
  // Convert typed value to the dimension's base. $4 / gal × (1 / 128)
  // = $0.03125 / fl oz; $8 / oz × 16 = $128 / lb. For a value already
  // typed in the base unit (LB / FLOZ / EA) the factor is 1 and the
  // division is a no-op.
  const storedPerBase = typedPerBase / factor;
  if (!Number.isFinite(storedPerBase) || storedPerBase <= 0) {
    return NextResponse.json({ error: "converted perBase is not finite" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) {
    return NextResponse.json({ error: "reason required" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemPriceOverride(client, {
      itemId,
      perBase: storedPerBase,
      baseUom: storedBase,
      reason,
      actorEmail: gate.email,
      // N6: typed values are recorded on the event for history, not on
      // the stored row. The writer threads these into event.after.
      typedPerBase,
      typedBaseUom: typedUom,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, twins: result.twins });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
