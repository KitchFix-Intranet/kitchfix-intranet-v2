import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { renameIngredient } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; newName?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ingredientId = body.ingredientId;
  const newName = (body.newName ?? "").trim();
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  if (newName.length < 2) return NextResponse.json({ error: "newName too short" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await renameIngredient(client, { ingredientId, newName, actorEmail: gate.email });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, aliasWritten: result.aliasWritten });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
