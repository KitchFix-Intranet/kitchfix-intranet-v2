// /api/academy/library/suggestions/[id]/handle
//
// POST { outcome: "used" | "no_change" } to close an open
// suggestion. Owner-only (requireOwnerApi), unchanged by the app-
// access flag - this is an office action, not a reader's. The
// suggestion must be open; already-closed rows return 404.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { handleSuggestion, type HandleOutcome } from "@/lib/academy/suggestions";

export const dynamic = "force-dynamic";

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
  const body = (raw && typeof raw === "object" ? raw : {}) as { outcome?: unknown };
  const outcome = body.outcome;
  if (outcome !== "used" && outcome !== "no_change") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const r = await handleSuggestion(id, outcome as HandleOutcome, g.email);
  if (r.ok) return NextResponse.json({ ok: true });
  if (r.error === "not_found_or_already_closed") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ error: "server_error", detail: r.error }, { status: 500 });
}
