import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { keepSeparate } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (itemIds.length === 0) return NextResponse.json({ error: "itemIds required" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await keepSeparate(client, { itemIds, actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
