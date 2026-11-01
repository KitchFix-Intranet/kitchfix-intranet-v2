import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { previewResaleCascade, setIngredientResale } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// GET returns the counts the Resale toggle hint needs. The DetailPanel
// shows "Also moves N confirmed items" BEFORE the user clicks, so the
// toggle never silently restatuses rows. Added here (not a new route)
// to keep the surface tight; same gate, same input shape.
export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const ingredientId = req.nextUrl.searchParams.get("ingredientId") ?? "";
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  const client = serviceClient();
  const r = await previewResaleCascade(client, { ingredientId });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ confirmedActive: r.confirmedActive, confirmedResale: r.confirmedResale });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; resale?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ingredientId = body.ingredientId;
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  if (typeof body.resale !== "boolean") return NextResponse.json({ error: "resale must be boolean" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await setIngredientResale(client, {
      ingredientId,
      resale: body.resale,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, moved: result.moved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
