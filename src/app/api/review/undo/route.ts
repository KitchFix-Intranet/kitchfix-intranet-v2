import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { undoConfirmMany } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  // Accepts one id or many. `itemId` is kept for RowSendBackButton and
  // the review queue's own undo; `itemIds` brings this route in line
  // with every other review action, which have all been plural since
  // the queue got multi-select.
  const ids = Array.isArray(body.itemIds)
    ? body.itemIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : body.itemId
      ? [body.itemId]
      : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "itemId or itemIds required" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await undoConfirmMany(client, { itemIds: ids, actorEmail: gate.email });
    if (!result.ok && result.undone === 0) {
      return NextResponse.json({ error: result.errors[0] ?? "undo failed" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      undone: result.undone,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
