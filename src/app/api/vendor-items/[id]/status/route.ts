import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { markArchived, markOneOff, restoreVendorItem } from "@/lib/reviewWrites";

// T4 §7: this route takes three requests only - archive, one-off,
// restore. Each goes through the same function as the review card
// (archive, one-off) or its own helper (restore). It no longer writes
// a bare status; the decision functions own the full shape (status +
// link_status + link_reason) and the `before` snapshot carried on the
// event. Anything else is refused at the edge.

type Action = "archive" | "one-off" | "restore";
const ALLOWED: ReadonlySet<Action> = new Set(["archive", "one-off", "restore"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  const action = body.action;
  if (!action || !ALLOWED.has(action as Action)) {
    return NextResponse.json(
      { error: "action must be one of: archive, one-off, restore" },
      { status: 400 },
    );
  }

  const client = serviceClient();

  try {
    if (action === "archive") {
      const r = await markArchived(client, { itemIds: [id], actorEmail: gate.email });
      if (r.marked === 0) {
        return NextResponse.json(
          { error: r.skipped > 0 ? "Already decided - nothing changed." : (r.errors[0] ?? "Nothing was saved.") },
          { status: 400 },
        );
      }
      return NextResponse.json({ ok: true, marked: r.marked, skipped: r.skipped, usd: r.usd, event_id: r.eventId ?? null });
    }
    if (action === "one-off") {
      const r = await markOneOff(client, { itemIds: [id], actorEmail: gate.email });
      if (r.marked === 0) {
        return NextResponse.json(
          { error: r.skipped > 0 ? "Already decided - nothing changed." : (r.errors[0] ?? "Nothing was saved.") },
          { status: 400 },
        );
      }
      return NextResponse.json({ ok: true, marked: r.marked, skipped: r.skipped, event_id: r.eventId ?? null });
    }
    // action === "restore"
    const r = await restoreVendorItem(client, { itemId: id, actorEmail: gate.email });
    if (!r.ok) {
      return NextResponse.json({ error: r.error ?? "Nothing was saved." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, restored: r.restored, event_id: r.eventId ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
