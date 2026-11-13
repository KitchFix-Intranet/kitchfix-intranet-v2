import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientEachMeasure } from "@/lib/reviewWrites";
import { DIM_BY_UOM, TO_BASE } from "@/lib/ingredients/pack";
import { isMeasuresWorld, readMeasuresForIngredient } from "@/lib/ingredients/measuresRead";
import type { Measure, MeasureSource } from "@/lib/ingredients/measures";

export const dynamic = "force-dynamic";

// N6: the measure of one each on an ingredient. Two shapes:
//   { ingredientId, qty: number, uom: string, source: string }  - set
//   { ingredientId, qty: null }                                  - clear
// Setting requires a weight OR volume uom from the shared vocabulary,
// a finite qty > 0 and <= 100,000, and a source in the enumeration.
// Clearing sends null for qty; uom and source are ignored and the
// helper nulls all three columns together.
//
// Sanity bound on the CONVERTED value: a weight above 200 lb or a
// volume above 55 gal is refused with a plain message - a real head of
// lettuce is not 300 lb and a real bottle of oil is not 60 gal; a user
// who typed one of those almost certainly got the unit wrong.
const MEASURE_SOURCES = new Set(["house_test", "book", "vendor_spec", "estimate"]);
const MAX_LB = 200;
const MAX_GAL = 55;

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; qty?: unknown; uom?: unknown; source?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const ingredientId = body.ingredientId;
  if (typeof ingredientId !== "string" || ingredientId.length === 0) {
    return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  }

  // qty: null to clear; number > 0 to set.
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
  let source: string | null;
  if (qty == null) {
    uom = null;
    source = null;
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
    // Sanity bound on the converted value.
    if (dim === "weight") {
      const asLb = qty * factor;
      if (asLb > MAX_LB) {
        return NextResponse.json({ error: `measure above ${MAX_LB} lb is implausible for one each` }, { status: 400 });
      }
    } else {
      const asFloz = qty * factor;
      const asGal = asFloz / TO_BASE["GAL"]; // TO_BASE["GAL"] = 128
      if (asGal > MAX_GAL) {
        return NextResponse.json({ error: `measure above ${MAX_GAL} gal is implausible for one each` }, { status: 400 });
      }
    }
    uom = u;
    if (typeof body.source !== "string" || !MEASURE_SOURCES.has(body.source)) {
      return NextResponse.json({ error: "source must be one of house_test, book, vendor_spec, estimate" }, { status: 400 });
    }
    source = body.source;
  }

  try {
    const client = serviceClient();

    // M1 amendment 3: before the write, remember which count-to-X row
    // we'll be replacing/removing in the measures table (if 0019 is
    // applied). The dim comes from the OLD uom when clearing, the NEW
    // uom when setting.
    let dualTargetDim: "weight" | "volume" | null = null;
    if (qty != null && uom) {
      const d = DIM_BY_UOM[uom];
      if (d === "weight" || d === "volume") dualTargetDim = d;
    } else {
      // Clearing. Read the current stored uom so we know which row to
      // remove from pr_ingredient_measures. Null if there was none.
      const { data: pre } = await client
        .from("pr_ingredients")
        .select("each_measure_uom")
        .eq("id", ingredientId)
        .maybeSingle();
      const preUom = (pre as { each_measure_uom: string | null } | null)?.each_measure_uom ?? null;
      if (preUom) {
        const d = DIM_BY_UOM[preUom.toUpperCase()];
        if (d === "weight" || d === "volume") dualTargetDim = d;
      }
    }

    const result = await setIngredientEachMeasure(client, {
      ingredientId,
      qty,
      uom,
      source,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    // Dual-write to pr_ingredient_measures when the table exists
    // (amendment 3). Before 0019 the table is absent and nothing more
    // happens: the route behaves exactly as today. After 0019 the
    // ingredient's count-to-weight or count-to-volume row is replaced
    // (set) or removed (clear), with any volume-to-weight row left
    // alone.
    if (await isMeasuresWorld(client)) {
      const existing = await readMeasuresForIngredient(client, ingredientId);
      // Keep every row EXCEPT the one count-to-<target> row we're
      // governing. When dualTargetDim is null (clearing with no prior
      // dim stored), leave the measures list alone.
      const kept: Measure[] = dualTargetDim
        ? existing.filter((m) => {
            const fd = DIM_BY_UOM[m.from_unit.toUpperCase()];
            const td = DIM_BY_UOM[m.to_unit.toUpperCase()];
            return !(fd === "count" && td === dualTargetDim);
          })
        : existing;
      const nextMeasures: Measure[] = [...kept];
      if (qty != null && uom && dualTargetDim) {
        nextMeasures.push({
          from_unit: "EA",
          qty: Number(qty),
          to_unit: uom,
          source: ((source ?? "estimate") as MeasureSource),
        });
      }
      // No-op guard: if the list is byte-identical to existing, skip.
      const sameList =
        existing.length === nextMeasures.length &&
        existing.every((e, i) => {
          const n = nextMeasures[i];
          return (
            e.from_unit === n.from_unit &&
            e.to_unit === n.to_unit &&
            Number(e.qty) === Number(n.qty) &&
            e.source === n.source
          );
        });
      if (!sameList) {
        const { error: rpcErr } = await client.rpc("pr_set_ingredient_measures", {
          p_ingredient: ingredientId,
          p_measures: nextMeasures,
          p_actor: gate.email,
        });
        if (rpcErr) {
          // Legacy write already landed; surface the measures-side
          // failure without a rollback (the legacy columns remain the
          // backstop while 0019 is still in flight).
          return NextResponse.json({ ok: true, measuresWarning: rpcErr.message });
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
