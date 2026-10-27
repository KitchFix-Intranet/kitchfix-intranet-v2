import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { migrateTextPackOverrides } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// One-time (idempotent) migration: convert the pre-Phase-1.8 text
// overrides to the structured shape so each row carries qty/size/uom
// and a recomputed per-base. Owner-gated. Rows already structured
// (pack_override.qty populated) are skipped.
export async function POST(_req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  try {
    const client = serviceClient();
    const result = await migrateTextPackOverrides(client, { actorEmail: gate.email });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
