import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { undoMergeIngredient } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { sourceId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const sourceId = body.sourceId;
  if (!sourceId) return NextResponse.json({ error: "sourceId required" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await undoMergeIngredient(client, { sourceId, actorEmail: gate.email });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
      ok: true,
      restoredItems: result.restoredItems,
      restoredGoldenLinks: result.restoredGoldenLinks,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
