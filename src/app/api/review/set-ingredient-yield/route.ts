import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// M1: ingredient yield. Stored and returned; nothing computes with it
// until recipes exist (§2.4). Shapes:
//   { ingredientId, yieldPct: number, yieldSource: string }  - set
//   { ingredientId, yieldPct: null, yieldSource: null }      - clear
//
// Amendment 7: yield is a decimal number, not an integer (one decimal
// place is enough: 87.5 reads cleanly). Range is the database's:
// > 0 and <= 100. Source enum matches migration 0019's
// pr_ingredients_yield_source_vocab.

const YIELD_SOURCES: ReadonlySet<string> = new Set([
  "house_test",
  "book",
  "vendor_spec",
  "estimate",
]);
const MAX_YIELD = 100;

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const actorEmail = (gate as { email: string }).email;

  let body: { ingredientId?: unknown; yieldPct?: unknown; yieldSource?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const ingredientId = typeof body.ingredientId === "string" ? body.ingredientId : null;
  if (!ingredientId) {
    return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  }

  // DB: pr_ingredients_yield_pair enforces "both set or both null".
  const clearing = body.yieldPct === null && body.yieldSource === null;
  const setting =
    body.yieldPct !== null && body.yieldSource !== null;
  if (!clearing && !setting) {
    return NextResponse.json(
      { error: "yieldPct and yieldSource must be set together or cleared together" },
      { status: 400 },
    );
  }

  let yieldPct: number | null;
  let yieldSource: string | null;
  if (clearing) {
    yieldPct = null;
    yieldSource = null;
  } else {
    if (typeof body.yieldPct !== "number" || !Number.isFinite(body.yieldPct)) {
      return NextResponse.json({ error: "yieldPct must be a finite number" }, { status: 400 });
    }
    // DB: pr_ingredients_yield_range (> 0 and <= 100).
    if (body.yieldPct <= 0 || body.yieldPct > MAX_YIELD) {
      return NextResponse.json(
        { error: `yieldPct must be greater than 0 and at most ${MAX_YIELD}` },
        { status: 400 },
      );
    }
    if (typeof body.yieldSource !== "string" || !YIELD_SOURCES.has(body.yieldSource)) {
      return NextResponse.json(
        { error: "yieldSource must be one of house_test, book, vendor_spec, estimate" },
        { status: 400 },
      );
    }
    yieldPct = body.yieldPct;
    yieldSource = body.yieldSource;
  }

  const supa = serviceClient();

  const { data: cur, error: curErr } = await supa
    .from("pr_ingredients")
    .select("id,yield_pct,yield_source,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (curErr) return NextResponse.json({ error: curErr.message }, { status: 500 });
  if (!cur) return NextResponse.json({ error: "Ingredient not found" }, { status: 404 });
  const row = cur as { yield_pct: number | null; yield_source: string | null; status: string };
  if (row.status === "merged") {
    return NextResponse.json({ error: "Ingredient is merged" }, { status: 400 });
  }

  const beforePct = row.yield_pct == null ? null : Number(row.yield_pct);
  const beforeSource = row.yield_source ?? null;
  if (beforePct === yieldPct && beforeSource === yieldSource) {
    return NextResponse.json({ ok: true });
  }

  const { error: upErr } = await supa
    .from("pr_ingredients")
    .update({
      yield_pct: yieldPct,
      yield_source: yieldSource,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ingredientId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

  await supa.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_yield_set",
    before: { yield_pct: beforePct, yield_source: beforeSource },
    after: { yield_pct: yieldPct, yield_source: yieldSource },
    actor: actorEmail,
  });

  return NextResponse.json({ ok: true });
}
