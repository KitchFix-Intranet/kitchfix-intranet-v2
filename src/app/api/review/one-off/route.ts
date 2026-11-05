// POST /api/review/one-off
//
// Q2 §2. One-off purchase disposition - real food bought once that
// doesn't deserve a master. 160 ai-new-proposed items in the Nov queue
// fall in this bucket worth ~$24.6k. Previously they would each have
// become a new ingredient that'd never appear in a recipe.
//
// Write path: lib/reviewWrites.ts markOneOff(). Same shape as
// markNotFood but with reason prefix 'oneoff:' and kind 'review_oneoff'.
// is_food stays true.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { markOneOff } from "@/lib/reviewWrites";

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
    const result = await markOneOff(client, { itemIds, actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
