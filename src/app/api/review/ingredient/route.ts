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
      // N6: each_measure_* trio replaces N5's avg_weight_lb/source on
      // the two SELECTs so the panel's Edit-ingredient block reads the
      // measure shape.
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source")
      .eq("id", id)
      .maybeSingle(),
    client
      .from("pr_ingredients")
      // N6: each_measure_* trio replaces N5's avg_weight_lb/source on
      // the two SELECTs so the panel's Edit-ingredient block reads the
      // measure shape.
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source")
      .eq("status", "active")
      .order("name"),
  ]);
  if (ingRes.error) return NextResponse.json({ error: ingRes.error.message }, { status: 500 });
  if (!ingRes.data) return NextResponse.json({ error: "Ingredient not found" }, { status: 404 });
  if (parentsRes.error) return NextResponse.json({ error: parentsRes.error.message }, { status: 500 });

  const ingredient = ingRes.data as ReviewCardIngredient;
  const parents = (parentsRes.data ?? []) as ReviewCardIngredient[];

  return NextResponse.json({ ingredient, parents });
}
