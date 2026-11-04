// POST /api/review/set-grade
//
// G1 (grade model). Sets or clears pr_vendor_items.grade. Null is
// standard; 'premium' is the only sanctioned non-null value today.
//
// Body: { itemId: string, grade: "premium" | null }
//
// The write helper (setVendorItemGrade in reviewWrites.ts) emits
// one pr_events row with BOTH before and after populated.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setVendorItemGrade } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { itemId?: string; grade?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });

  // Wire-level guard. Only the sanctioned two values are accepted.
  // UI narrows this already; the server re-checks because a third
  // value in the column would create its own tier the UI would
  // silently treat as standard.
  const rawGrade = body.grade;
  if (rawGrade !== "premium" && rawGrade !== null) {
    return NextResponse.json(
      { error: "grade must be 'premium' or null" },
      { status: 400 }
    );
  }

  try {
    const client = serviceClient();
    const result = await setVendorItemGrade(client, {
      itemId,
      grade: rawGrade,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
