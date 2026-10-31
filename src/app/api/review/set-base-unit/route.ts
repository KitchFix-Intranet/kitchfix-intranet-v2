import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientBaseUnit } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// Matches the pr_ingredients CHECK constraint:
//   base_unit = ANY (ARRAY['lb','each','gal','dozen'])
const BASE_UNITS = new Set(["lb", "each", "gal", "dozen"]);

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; baseUnit?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ingredientId = body.ingredientId;
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });

  const baseUnit = typeof body.baseUnit === "string" ? body.baseUnit.trim().toLowerCase() : "";
  if (!BASE_UNITS.has(baseUnit)) {
    return NextResponse.json({ error: "unknown base unit" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await setIngredientBaseUnit(client, {
      ingredientId,
      baseUnit,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
