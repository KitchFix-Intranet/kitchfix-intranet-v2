import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemEachMeasure } from "@/lib/reviewWrites";
import { DIM_BY_UOM, TO_BASE } from "@/lib/ingredients/pack";

// M1 amendment 3: count packs with a weight-each measure translate
// directly into a case weight; migration 0019 populated the 7 existing
// rows with this same formula. For any other pack/measure shape (a
// volume-each on a count pack, or any volume-pack case) the case
// weight cannot be derived from the two inputs alone, so this dual-
// write leaves case_weight_lb alone and the pricing path falls back
// to the ingredient's measures.
const COUNT_PACK_UOMS: ReadonlySet<string> = new Set(["EA", "CT", "PC", "DZ"]);
const WEIGHT_MEASURE_UOMS: ReadonlySet<string> = new Set(["LB", "OZ", "KG", "G"]);
// Migration 0019 line 4b: DZ expands to 12 inside the pack count.
const PACK_UOM_MULT: Record<string, number> = { EA: 1, CT: 1, PC: 1, DZ: 12 };

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

    // M1 amendment 3: read the item's pack shape now so the case
    // weight dual-write can compute the right number after the legacy
    // save lands. pack_qty + pack_size + pack_uom are stable enough
    // to read once and reuse.
    const { data: pre } = await client
      .from("pr_vendor_items")
      .select("pack_qty,pack_size,pack_uom")
      .eq("id", itemId)
      .maybeSingle();
    const packQty = Number((pre as { pack_qty: number | null } | null)?.pack_qty ?? 1) || 1;
    const packSize = Number((pre as { pack_size: number | null } | null)?.pack_size ?? 1) || 1;
    const packUom = String((pre as { pack_uom: string | null } | null)?.pack_uom ?? "").toUpperCase();

    const result = await setVendorItemEachMeasure(client, {
      itemId,
      qty,
      uom,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    // Dual-write case_weight_lb on the item. Only fires when the pack
    // is count-based and the measure is weight-based - the one shape
    // migration 0019 populates (lines 4b). For every other shape the
    // case_weight_lb column stays untouched; pricing falls back to the
    // ingredient's measures (which cover count->volume and volume->
    // weight bridges).
    //
    // Both worlds: pre-0019 the column does not exist and the update
    // fails with 42703 (undefined_column). We catch that silently so
    // the legacy write is still authoritative. Post-0019 the update
    // lands and the number on the panel changes.
    const dualFires =
      COUNT_PACK_UOMS.has(packUom) &&
      (qty == null || (uom != null && WEIGHT_MEASURE_UOMS.has(uom)));
    if (dualFires) {
      let caseWeightLb: number | null = null;
      if (qty != null && uom != null) {
        const packCount = packQty * packSize * (PACK_UOM_MULT[packUom] ?? 1);
        const perOneInLb = qty * TO_BASE[uom];
        // Mirror migration 0019's round(..., 3).
        caseWeightLb = Math.round(packCount * perOneInLb * 1000) / 1000;
      }
      const nowIso = new Date().toISOString();
      const { error: upErr } = await client
        .from("pr_vendor_items")
        .update({
          case_weight_lb: caseWeightLb,
          case_weight_set_by: caseWeightLb == null ? null : gate.email,
          case_weight_set_at: caseWeightLb == null ? null : nowIso,
        })
        .eq("id", itemId);
      if (upErr) {
        // Pre-0019 column absent: silent. Other errors: surface as a
        // non-blocking warning so the legacy response stays ok.
        const m = upErr.message?.toLowerCase() ?? "";
        const isUndefinedColumn = m.includes("case_weight_lb") && m.includes("does not exist");
        if (!isUndefinedColumn) {
          return NextResponse.json({ ok: true, caseWeightWarning: upErr.message });
        }
      } else {
        await client.from("pr_events").insert({
          entity_type: "vendor_item",
          entity_id: itemId,
          kind: "vendor_item_case_weight_set",
          before: null,
          after: { case_weight_lb: caseWeightLb, derived_from: "each_measure" },
          actor: gate.email,
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
