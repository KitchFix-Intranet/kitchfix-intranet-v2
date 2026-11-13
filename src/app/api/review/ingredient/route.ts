// GET /api/review/ingredient?id=<uuid>
//
// Returns the facts the DetailPanel's ingredient-mode needs:
//   { ingredient: ReviewCardIngredient; parents: ReviewCardIngredient[] }
//
// Mirror of /api/review/item (A1): the Review queue hands these two
// shapes in from props it already has in memory; the Ingredients
// pane only holds the thin MasterRow projection, so the panel needs
// a second way in - by ingredientId, fetching its own facts.
//
// The ReviewCardIngredient mapping below mirrors ReviewQueue.tsx:127
// (which selects `id,name,parent,category,resale,base_unit` on
// pr_ingredients with status='active') so the panel reads identical
// values from either door.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import type { ReviewCardIngredient } from "@/components/ingredients/itemTypes";
import {
  isMeasuresWorld,
  readMeasuresForIngredient,
  legacyEachMeasureToMeasures,
} from "@/lib/ingredients/measuresRead";
// M2 §4B part 2: shape helper no longer called here. Nothing on
// screen reads each_measure_*.
// Polish round 2 fix 2: ingredient payload carries blendedAvgPerBase
// so attention's outlier head reads the same figure as the Ingredients
// tab. Same code path (blendStats + priceInUnit).
import { priceInUnit } from "@/lib/ingredients/measures";
import { blendStats } from "@/lib/ingredients/blend";
import { canonicalFromBaseUnit } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Reject malformed uuids at the edge so Postgres never sees them.
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id must be a uuid" }, { status: 400 });

  const client = serviceClient();

  // The ingredient's own row + the full active-parents list for the
  // panel's sub-category and merge dropdowns, in parallel.
  const [ingRes, parentsRes] = await Promise.all([
    client
      .from("pr_ingredients")
      // N6 + M1: each_measure_* trio stays (read path §2.6 fallback);
      // yield_pct/yield_source added for the panel's Yield row (M1
      // amendment 7).
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source,yield_pct,yield_source")
      .eq("id", id)
      .maybeSingle(),
    client
      .from("pr_ingredients")
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source,yield_pct,yield_source")
      .eq("status", "active")
      .order("name"),
  ]);
  if (ingRes.error) return NextResponse.json({ error: ingRes.error.message }, { status: 500 });
  if (!ingRes.data) return NextResponse.json({ error: "Ingredient not found" }, { status: 404 });
  if (parentsRes.error) return NextResponse.json({ error: parentsRes.error.message }, { status: 500 });

  const rawIngredient = ingRes.data as ReviewCardIngredient;
  const parents = (parentsRes.data ?? []) as ReviewCardIngredient[];

  // M1 R2 fix 1 + amendment 4: one world per request. In measures-
  // world rewrite the legacy each_measure_* triple on the ingredient
  // from the new count-to-X row so deriveRecipePrice sees the new
  // numbers without a JSX change.
  const newWorld = await isMeasuresWorld(client);
  let measures: ReturnType<typeof legacyEachMeasureToMeasures> = [];
  let ingredient: ReviewCardIngredient = rawIngredient;
  if (newWorld) {
    measures = await readMeasuresForIngredient(client, id);
    // M2 §4B part 2: no legacy-triple reshape. Nothing on screen
    // reads each_measure_*; the authoritative shape is `measures`
    // which rides on the response below.
    ingredient = rawIngredient;
  } else {
    measures = legacyEachMeasureToMeasures(
      rawIngredient.each_measure_qty,
      rawIngredient.each_measure_uom,
      rawIngredient.each_measure_source,
    );
  }
  const yieldPct = (ingredient as { yield_pct?: number | null }).yield_pct ?? null;
  const yieldSource = (ingredient as { yield_source?: string | null }).yield_source ?? null;

  // Polish round 2 fix 2: compute blended lens $ / base_unit across
  // THIS ingredient's linked items. Same code path IngredientMasters
  // + /api/review/item use; attention's outlier head reads this.
  let blendedAvgPerBase: number | null = null;
  const targetUom = canonicalFromBaseUnit(ingredient.base_unit);
  if (targetUom) {
    const { data: mates } = await client
      .from("pr_vendor_items")
      .select("id,pack_qty,pack_size,pack_uom,case_weight_lb,price_estimate,usd_12m")
      .eq("ingredient_id", id);
    const priced: Array<{ id: string; v: number; usd: number }> = [];
    for (const row of (mates ?? []) as Array<{
      id: string;
      pack_qty: number | null;
      pack_size: number | null;
      pack_uom: string | null;
      case_weight_lb: number | null;
      price_estimate: { per_base?: number | string | null; base_uom?: string | null } | null;
      usd_12m: number | null;
    }>) {
      const pe = row.price_estimate ?? null;
      const matePerBase = pe?.per_base != null ? Number(pe.per_base) : null;
      const mateBaseUom = pe?.base_uom ?? null;
      if (matePerBase == null || !Number.isFinite(matePerBase) || matePerBase <= 0 || !mateBaseUom) continue;
      const r = priceInUnit(
        {
          perBase: matePerBase,
          baseUom: mateBaseUom,
          packQty: row.pack_qty,
          packSize: row.pack_size,
          packUom: row.pack_uom,
          caseWeightLb: row.case_weight_lb,
        },
        targetUom,
        { measures },
      );
      if (r?.per != null && Number.isFinite(r.per) && r.per > 0) {
        priced.push({ id: row.id, v: r.per, usd: Number(row.usd_12m ?? 0) });
      }
    }
    const stats = blendStats(priced);
    blendedAvgPerBase = stats.survivorMean;
  }

  // M2 §4B part 2: project measures + yield onto the ingredient
  // object itself so PanelIngredientZone's new Measures + Yield rows
  // read from one place. The top-level sibling fields stay for any
  // reader still using them.
  const ingredientOut = {
    ...ingredient,
    measures,
    yieldPct,
    yieldSource,
    blendedAvgPerBase,
  };
  return NextResponse.json({
    ingredient: ingredientOut,
    parents,
    measures,
    yieldPct,
    yieldSource,
  });
}
