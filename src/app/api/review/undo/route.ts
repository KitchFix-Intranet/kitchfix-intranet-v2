import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { undoConfirmMany, undoDecisionEvent } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// T4 §3: one route takes any decision back from its event. It accepts
//   { eventId }               -> the preferred new shape; reads the
//                                event's before snapshot and writes it.
//   { itemId }  or  { itemIds }  -> legacy shape kept so the review
//                                card's own Undo and the ledger's
//                                Undo button on pre-T4 confirms keep
//                                working byte-for-byte. Routes through
//                                undoConfirmMany which only reverses
//                                confirms.
//
// When the item has moved on since the decision, the response says so
// in a sentence the UI can show as-is. See reviewWrites.undoDecisionEvent.
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { eventId?: string; itemId?: string; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  if (typeof body.eventId === "string" && body.eventId.length > 0) {
    try {
      const client = serviceClient();
      const result = await undoDecisionEvent(client, {
        eventId: body.eventId,
        actorEmail: gate.email,
      });
      if (!result.ok && result.reverted === 0) {
        return NextResponse.json({ error: result.error ?? "undo failed" }, { status: 400 });
      }
      return NextResponse.json({
        ok: true,
        reverted: result.reverted,
        refused: result.refused,
        retiredIngredientId: result.retiredIngredientId ?? null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // Legacy path (item-level Undo on the review card, and the ledger's
  // Undo on pre-T4 confirms). undoConfirmMany only undoes a confirm; it
  // returns a plain sentence when the item is not confirmed, which the
  // caller already shows.
  const ids = Array.isArray(body.itemIds)
    ? body.itemIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : body.itemId
      ? [body.itemId]
      : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "eventId, itemId or itemIds required" }, { status: 400 });
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
