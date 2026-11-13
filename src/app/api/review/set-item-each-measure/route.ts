import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemEachMeasure } from "@/lib/reviewWrites";
import { DIM_BY_UOM, TO_BASE } from "@/lib/ingredients/pack";
import { isMeasuresWorld } from "@/lib/ingredients/measuresRead";

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

    // Read the item's pack shape so the case_weight_lb dual-write can
    // compute count * weight_of_one.
    const { data: pre } = await client
      .from("pr_vendor_items")
      .select("pack_qty,pack_size,pack_uom")
      .eq("id", itemId)
      .maybeSingle();
    const packQty = Number((pre as { pack_qty: number | null } | null)?.pack_qty ?? 1) || 1;
    const packSize = Number((pre as { pack_size: number | null } | null)?.pack_size ?? 1) || 1;
    const packUom = String((pre as { pack_uom: string | null } | null)?.pack_uom ?? "").toUpperCase();

    // M1 R2 fix 4: in measures-world the case_weight_lb write goes
    // FIRST. If it fails, the legacy columns are not touched. If the
    // legacy write then fails, the item reads new numbers via the
    // shaped payload but each_measure_qty/uom are stale. The next
    // successful save through this route repairs it.
    const measuresWorld = await isMeasuresWorld(client);
    const dualFires =
      measuresWorld &&
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
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

      const { error: evErr } = await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: itemId,
        kind: "vendor_item_case_weight_set",
        before: null,
        after: { case_weight_lb: caseWeightLb, derived_from: "each_measure" },
        actor: gate.email,
      });
      if (evErr) return NextResponse.json({ error: evErr.message }, { status: 400 });
    }
    // For a volume measure or a non-count pack the case_weight_lb
    // column stays untouched; pricing falls back to the ingredient's
    // measures (volume-to-weight bridge). This is by design, not a
    // silent omission: a 25-gal cask with a stored "one gal is 7.6 lb"
    // ingredient-side measure prices through the ingredient path,
    // which already composes the right number.

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
