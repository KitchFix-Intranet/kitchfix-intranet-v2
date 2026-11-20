// Push-again route (train 4, carry-in 1).
//
// POST /api/service/push-again  { rowId }
//
// Gate order:
//   1. requireOwnerApi()                 -> 401/404 verbatim
//   2. canPushAgainDb (is_sc_lock_override + SC_V2_OUTBOUND != off)
//      -> 403 NOT_ALLOWED
//   3. pushAgain(rowId)                  -> delegates to submit lib
//
// The submit library already enforces not_v2 / already_done /
// not_given_up / reverted / race_lost. No retry loop fires from
// this handler; pushAgain resets push_attempts to 0 and
// push_next_try_at to now, and the push cron handles the rest.

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { canPushAgainDb } from "@/lib/sc/submit/pushAgainScope";
import { pushAgain } from "@/lib/sc/submit/push";

export const dynamic = "force-dynamic";

interface Body {
  rowId?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, { status: 400 });
  }
  const rowId = typeof body.rowId === "string" ? body.rowId : null;
  if (!rowId) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "rowId required" }, { status: 400 });
  }

  const sb = serviceClient();
  const allowed = await canPushAgainDb(sb, gate.email);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, code: "NOT_ALLOWED", message: "This viewer cannot push the invoice again." },
      { status: 403 },
    );
  }

  try {
    const result = await pushAgain(rowId, sb);
    if (!result.ok) {
      return NextResponse.json({ ok: false, code: "REFUSED", reason: result.reason }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: msg }, { status: 500 });
  }
}
