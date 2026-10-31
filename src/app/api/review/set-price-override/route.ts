// POST /api/review/set-price-override
//
// Direct per-base price override. Separate from set-pack-override:
// this fixes the SYMPTOM (the number is wrong) without claiming the
// pack is human-set. See setVendorItemPriceOverride in
// src/lib/reviewWrites.ts for the backfill-durability caveat.
//
// Body: { itemId, perBase, baseUom, reason }
//   perBase - positive finite number
//   baseUom - LB | FLOZ | EA (case-insensitive on the wire)
//   reason  - non-empty; a hand-set price with no stated reason is
//             how a catalog rots quietly.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemPriceOverride } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

const ALLOWED_BASE_UOMS = new Set(["LB", "FLOZ", "EA"]);

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; perBase?: unknown; baseUom?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });

  const perBase = Number(body.perBase);
  if (!Number.isFinite(perBase) || perBase <= 0) {
    return NextResponse.json({ error: "perBase must be a positive finite number" }, { status: 400 });
  }

  const baseUom = typeof body.baseUom === "string" ? body.baseUom.trim().toUpperCase() : "";
  if (!ALLOWED_BASE_UOMS.has(baseUom)) {
    return NextResponse.json({ error: "baseUom must be LB, FLOZ, or EA" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) {
    return NextResponse.json({ error: "reason required" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemPriceOverride(client, {
      itemId,
      perBase,
      baseUom,
      reason,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, twins: result.twins });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
