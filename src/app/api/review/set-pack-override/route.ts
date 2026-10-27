import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemPackOverride } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

const ALLOWED_UOMS = new Set([
  "LB", "OZ", "G", "KG",
  "FLOZ", "L", "ML", "GAL", "QT", "PT",
  "EA", "CT", "DZ", "PC",
]);

// Phase 1.8: payload is structured. For non-catch items the client
// sends qty + size + uom (dropdown). For catch-weight items the client
// sends per_lb. billed_unit is a display aid for the row; note is
// optional. All validation is server-side.
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: {
    itemId?: string;
    catchWeight?: boolean;
    qty?: unknown;
    size?: unknown;
    uom?: unknown;
    perLb?: unknown;
    billedUnit?: unknown;
    note?: unknown;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const itemId = body.itemId;
  if (!itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });
  const catchWeight = body.catchWeight === true;

  const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const uomStr =
    typeof body.uom === "string" && body.uom.trim().length > 0
      ? body.uom.trim().toUpperCase()
      : null;
  if (uomStr != null && !ALLOWED_UOMS.has(uomStr)) {
    return NextResponse.json({ error: `unsupported uom: ${uomStr}` }, { status: 400 });
  }
  const billedUnit =
    typeof body.billedUnit === "string" && body.billedUnit.trim().length > 0
      ? body.billedUnit.trim()
      : null;
  const note = typeof body.note === "string" && body.note.trim().length > 0 ? body.note.trim() : null;

  // Lightweight required-field checks: catch-weight needs per_lb; the
  // non-catch path needs qty + size + uom. estimateFromOverride handles
  // the fallthrough to null per_base when something's missing, but we
  // reject at the API boundary to keep accidental saves from stamping
  // an empty override.
  if (catchWeight) {
    const perLb = toNum(body.perLb);
    if (perLb == null) return NextResponse.json({ error: "catch-weight: $/lb required" }, { status: 400 });
    try {
      const client = serviceClient();
      const result = await setVendorItemPackOverride(client, {
        itemId,
        payload: {
          catch_weight: true,
          qty: null,
          size: null,
          uom: null,
          per_lb: perLb,
          billed_unit: billedUnit,
          note,
        },
        actorEmail: gate.email,
      });
      if (!result.ok) return NextResponse.json({ error: result.error ?? "write failed" }, { status: 500 });
      return NextResponse.json({
        ok: true,
        twins: result.twins,
        perBase: result.perBase,
        baseUom: result.baseUom,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  const qty = toNum(body.qty);
  const size = toNum(body.size);
  if (qty == null || size == null || uomStr == null) {
    return NextResponse.json({ error: "non-catch: qty, size, uom all required" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemPackOverride(client, {
      itemId,
      payload: {
        catch_weight: false,
        qty,
        size,
        uom: uomStr,
        per_lb: null,
        billed_unit: billedUnit,
        note,
      },
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "write failed" }, { status: 500 });
    return NextResponse.json({
      ok: true,
      twins: result.twins,
      perBase: result.perBase,
      baseUom: result.baseUom,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
