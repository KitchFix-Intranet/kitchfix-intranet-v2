import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { priceInUnit, rejectReason, type Measure, type MeasureSource } from "@/lib/ingredients/measures";
import { isMeasuresWorld, readMeasuresForIngredient } from "@/lib/ingredients/measuresRead";
import { canonicalFromBaseUnit } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

// M1: the measures route. Whole-list replace. Three shapes:
//   { ingredientId, measures: [...] }               - set (full replace)
//   { ingredientId, measures: [] }                  - clear
//   { ingredientId, measures: [...], dryRun: true } - dry-run; no write
//
// The write goes through the SECURITY DEFINER function
// pr_set_ingredient_measures(uuid, jsonb, text) that migration 0019
// installs. That function inserts the pr_events row (kind
// ingredient_measures_set); the route does NOT write a second event.
//
// Service-role has NO DELETE on pr_ingredient_measures; the only path
// that removes a row is inside pr_set_ingredient_measures.
//
// Validation runs in the route via rejectReason() before the rpc, so
// the user gets the render's sentences. DB constraints are the
// backstop.

type IncomingMeasure = {
  from_unit: unknown;
  qty: unknown;
  to_unit: unknown;
  source: unknown;
};

function parseMeasure(raw: IncomingMeasure): { ok: true; m: Measure } | { ok: false; error: string } {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, error: "each measure must be an object" };
  }
  const from_unit = typeof raw.from_unit === "string" ? raw.from_unit.toUpperCase() : null;
  const to_unit = typeof raw.to_unit === "string" ? raw.to_unit.toUpperCase() : null;
  const qtyN = typeof raw.qty === "number" ? raw.qty : Number(raw.qty);
  const source = typeof raw.source === "string" ? raw.source.toLowerCase() : null;
  if (!from_unit) return { ok: false, error: "from_unit required" };
  if (!to_unit) return { ok: false, error: "to_unit required" };
  if (!Number.isFinite(qtyN)) return { ok: false, error: "qty must be a finite number" };
  if (!source) return { ok: false, error: "source required" };
  return {
    ok: true,
    m: {
      from_unit,
      qty: qtyN,
      to_unit,
      source: source as MeasureSource,
    },
  };
}

// M2 R1 amendment 3: dry-run now calls priceInUnit, the one price
// function. For each linked item, compute price-in-base_unit with
// the old measures and with the proposed ones; count items where
// the number moves. Items whose case states the target kind (or
// whose case_weight_lb replaces the weight for them) do not move
// because priceInUnit does not consult measures when the target's
// kind is already stated.
async function computeDryRun(
  supa: ReturnType<typeof serviceClient>,
  ingredientId: string,
  afterMeasures: Measure[],
  beforeMeasures: Measure[],
): Promise<{ items: number }> {
  const { data: ing } = await supa
    .from("pr_ingredients")
    .select("base_unit")
    .eq("id", ingredientId)
    .maybeSingle();
  const baseUnit = (ing as { base_unit: string | null } | null)?.base_unit ?? null;
  if (!baseUnit) return { items: 0 };
  const targetUom = canonicalFromBaseUnit(baseUnit);
  if (!targetUom) return { items: 0 };
  const { data: items } = await supa
    .from("pr_vendor_items")
    .select("id,price_estimate,case_weight_lb,pack_qty,pack_size,pack_uom")
    .eq("ingredient_id", ingredientId);
  if (!items || items.length === 0) return { items: 0 };
  let changed = 0;
  for (const row of items) {
    const r = row as {
      price_estimate: { per_base?: number; base_uom?: string } | null;
      case_weight_lb: number | null;
      pack_qty: number | null;
      pack_size: number | null;
      pack_uom: string | null;
    };
    const pe = r.price_estimate;
    const perBase = pe?.per_base != null ? Number(pe.per_base) : null;
    const baseUom = pe?.base_uom ?? null;
    if (perBase == null || !baseUom) continue;
    const input = {
      perBase,
      baseUom,
      packQty: r.pack_qty,
      packSize: r.pack_size,
      packUom: r.pack_uom,
      caseWeightLb: r.case_weight_lb,
    };
    const before = priceInUnit(input, targetUom, { measures: beforeMeasures });
    const after = priceInUnit(input, targetUom, { measures: afterMeasures });
    const beforeVal = before?.per ?? null;
    const afterVal = after?.per ?? null;
    if (beforeVal !== afterVal) changed += 1;
  }
  return { items: changed };
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const actorEmail = (gate as { email: string }).email;

  let body: {
    ingredientId?: unknown;
    measures?: unknown;
    dryRun?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const ingredientId = typeof body.ingredientId === "string" ? body.ingredientId : null;
  if (!ingredientId) {
    return NextResponse.json({ error: "ingredientId required" }, { status: 400 });
  }
  if (!Array.isArray(body.measures)) {
    return NextResponse.json({ error: "measures must be an array" }, { status: 400 });
  }
  const dryRun = body.dryRun === true;

  // Parse + validate every row before committing to any write path.
  const parsed: Measure[] = [];
  for (const raw of body.measures as IncomingMeasure[]) {
    const r = parseMeasure(raw);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    parsed.push(r.m);
  }

  // Validate against the growing set (so each addition is checked
  // against the ones added before it): same sentences a user sees in
  // the render's add-a-measure form.
  const accepted: Measure[] = [];
  for (const m of parsed) {
    const why = rejectReason(m, accepted);
    if (why) return NextResponse.json({ error: why }, { status: 400 });
    accepted.push(m);
  }

  const supa = serviceClient();

  // Both-worlds guard: the measures route is new-world only. Before
  // migration 0019, the table does not exist; refuse with a clear
  // message instead of letting the rpc 500.
  if (!(await isMeasuresWorld(supa))) {
    return NextResponse.json(
      { error: "pr_ingredient_measures is not available on this database yet" },
      { status: 400 },
    );
  }

  // Dry-run: compute would-change count without writing.
  if (dryRun) {
    const beforeMeasures = await readMeasuresForIngredient(supa, ingredientId);
    const change = await computeDryRun(supa, ingredientId, accepted, beforeMeasures);
    return NextResponse.json({
      dryRun: true,
      before: beforeMeasures,
      after: accepted,
      wouldChange: change,
    });
  }

  // Write: all-or-nothing replace + pr_events row inside the function.
  const { data, error } = await supa.rpc("pr_set_ingredient_measures", {
    p_ingredient: ingredientId,
    p_measures: accepted,
    p_actor: actorEmail,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, measures: data ?? [] });
}
