import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { confirmItems, createIngredient } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// Create an ingredient from an ai-new (or ad-hoc) group, then confirm the
// member items into it in one request. The ingredient create + the confirm
// share the same actor email on the ledger.
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { name?: string; parent?: string | null; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const name = (body.name ?? "").trim();
  const parent = body.parent ? String(body.parent).trim() : null;
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (name.length < 2) return NextResponse.json({ error: "name required" }, { status: 400 });

  try {
    const client = serviceClient();
    const { id: ingredientId } = await createIngredient(client, {
      name,
      parent,
      actorEmail: gate.email,
    });
    const result = itemIds.length > 0
      ? await confirmItems(client, { ingredientId, itemIds, actorEmail: gate.email })
      : { confirmed: 0, usd: 0, errors: [] };
    return NextResponse.json({ ingredientId, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
