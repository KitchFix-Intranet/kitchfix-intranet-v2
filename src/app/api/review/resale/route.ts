import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { markResale } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  // B7: ingredientId is now required - markResale confirms the link
  // against a specific master (delegates to confirmItems). The
  // Review-queue card submitting this call passes
  // currentIngredientId alongside checkedIds.
  let body: { itemIds?: string[]; ingredientId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (itemIds.length === 0) return NextResponse.json({ error: "itemIds required" }, { status: 400 });
  const ingredientId = typeof body.ingredientId === "string" ? body.ingredientId : "";
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await markResale(client, { ingredientId, itemIds, actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
