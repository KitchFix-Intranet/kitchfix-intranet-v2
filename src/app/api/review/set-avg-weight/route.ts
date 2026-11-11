import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientAvgWeight } from "@/lib/reviewWrites";

export const dynamic = "force-dynamic";

// N5: the usual weight of one each. Two shapes:
//   { ingredientId, weightLb: number, source: string } - set
//   { ingredientId, weightLb: null }                   - clear
// Setting requires source to be one of house_test | book | vendor_spec |
// estimate (mirrors the DB check constraint on avg_weight_source).
// Clearing sends null for weightLb; source is ignored and the helper
// writes null into both columns together. Numeric rules match the DB:
// finite, > 0, <= 200, two stored decimals. Non-each masters are
// refused in the helper (400) - a weight on them cannot be read.
const AVG_WEIGHT_SOURCES = new Set(["house_test", "book", "vendor_spec", "estimate"]);

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; weightLb?: unknown; source?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const ingredientId = body.ingredientId;
  if (typeof ingredientId !== "string" || ingredientId.length === 0) {
    return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  }

  // weightLb: null to clear; number > 0, <= 200 to set.
  let weightLb: number | null;
  if (body.weightLb === null) {
    weightLb = null;
  } else if (typeof body.weightLb === "number" && Number.isFinite(body.weightLb)) {
    if (body.weightLb <= 0 || body.weightLb > 200) {
      return NextResponse.json({ error: "weightLb must be greater than 0 and at most 200" }, { status: 400 });
    }
    weightLb = body.weightLb;
  } else {
    return NextResponse.json({ error: "weightLb must be a finite number or null" }, { status: 400 });
  }

  let source: string | null;
  if (weightLb == null) {
    source = null;
  } else {
    if (typeof body.source !== "string" || !AVG_WEIGHT_SOURCES.has(body.source)) {
      return NextResponse.json({ error: "source must be one of house_test, book, vendor_spec, estimate" }, { status: 400 });
    }
    source = body.source;
  }

  try {
    const client = serviceClient();
    const result = await setIngredientAvgWeight(client, {
      ingredientId,
      weightLb,
      source,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
