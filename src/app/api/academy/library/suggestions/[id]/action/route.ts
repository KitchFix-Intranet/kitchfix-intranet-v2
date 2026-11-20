// /api/academy/library/suggestions/[id]/action
//
// Owner-only state-machine. Body shape:
//   { action: "accept" | "mark_done" | "decline" | "reopen",
//     reason?: string }
//
// `requireOwnerApi` is the first thing the handler runs. A non-owner
// (or an unauthenticated request) gets the gate's built-in 401/404.
//
// Response shape:
//   200 ok
//   400 bad_request         - JSON parse failed OR action unknown
//   404 not_found           - no row with that id
//   409 wrong_state         - the action is not allowed from this
//                             row's current state (e.g. mark_done
//                             on an open note, accept on a closed
//                             one, concurrent modify)
//   413 reason_too_long     - decline reason over 2000 characters
//   500 server_error        - anything else

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import {
  applyOwnerAction,
  type OwnerAction,
} from "@/lib/academy/suggestions";

export const dynamic = "force-dynamic";

const KNOWN_ACTIONS: OwnerAction[] = ["accept", "mark_done", "decline", "reopen"];

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  const { id } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as {
    action?: unknown;
    reason?: unknown;
  };
  const action = body.action;
  if (typeof action !== "string" || !KNOWN_ACTIONS.includes(action as OwnerAction)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason : null;

  const r = await applyOwnerAction(
    id,
    action as OwnerAction,
    g.email,
    { reason },
  );
  if (r.ok) return NextResponse.json({ ok: true });
  switch (r.error) {
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "wrong_state":
      return NextResponse.json({ error: "wrong_state" }, { status: 409 });
    case "reason_too_long":
      return NextResponse.json({ error: "reason_too_long" }, { status: 413 });
    default:
      return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
