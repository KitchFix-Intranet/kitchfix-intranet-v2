import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { relinkItems } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ingredientId = body.ingredientId;
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (!ingredientId || itemIds.length === 0) {
    return NextResponse.json({ error: "ingredientId and itemIds required" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await relinkItems(client, { ingredientId, itemIds, actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
