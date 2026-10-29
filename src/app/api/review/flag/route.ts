import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setFlag } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// Owner-gated POST. Body:
//   { itemIds: string[], flagged: boolean, note?: string|null }
// flagged=true + note: stamps flag_note/flagged_by/flagged_at on each
// flagged=false: clears those columns (unflag/resolve).
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemIds?: string[]; flagged?: boolean; note?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((x) => typeof x === "string") : [];
  const flagged = body.flagged === true;
  const note = typeof body.note === "string" ? body.note : null;
  if (itemIds.length === 0) return NextResponse.json({ error: "itemIds required" }, { status: 400 });

  try {
    const client = serviceClient();
    const result = await setFlag(client, { itemIds, flagged, note, actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
