import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientBaseUnit } from "@/lib/reviewWrites";
import { BASE_UNIT_VALUES } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

// N6: matches the pr_ingredients CHECK constraint widened in migration
// 0018 to accept every WEIGHT_UOMS + VOLUME_UOMS value plus each / dozen.
// Shared with the writer and the client dropdown via pack.ts so the
// three cannot drift.
const BASE_UNITS: ReadonlySet<string> = BASE_UNIT_VALUES as ReadonlySet<string>;

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
