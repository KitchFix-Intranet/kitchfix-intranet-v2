import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Read-only. Returns the last 20 pr_events relevant to a vendor-item
// detail panel: changes on the ingredient (rename, category, resale,
// merge, split-create, created) + changes on the vendor item (pack
// override, review undo). Caller passes ingredientId and/or itemId;
// at least one is required. Server builds the two-sided OR query and
// returns the rows merged + newest-first.
export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const url = new URL(req.url);
  const ingredientId = url.searchParams.get("ingredientId");
  const itemId = url.searchParams.get("itemId");
  if (!ingredientId && !itemId) {
    return NextResponse.json({ error: "ingredientId or itemId required" }, { status: 400 });
  }

  const client = serviceClient();

  // One query, two legs via .or(). PostgREST supports .or() with the
  // standard filter syntax. Each leg joins its entity type to its id.
  const legs: string[] = [];
  if (ingredientId) legs.push(`and(entity_type.eq.ingredient,entity_id.eq.${ingredientId})`);
  if (itemId) legs.push(`and(entity_type.eq.vendor_item,entity_id.eq.${itemId})`);

  const { data, error } = await client
    .from("pr_events")
    .select("id,kind,at,actor,entity_type,entity_id,before,after")
    .or(legs.join(","))
    .order("at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ events: data ?? [] });
}
