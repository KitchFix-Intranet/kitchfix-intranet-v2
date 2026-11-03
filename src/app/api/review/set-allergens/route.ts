// POST /api/review/set-allergens
//
// B1 (allergens). Writes the master's Top-9 allergen review:
//   - replaces pr_ingredients.allergens with the submitted array
//   - stamps allergens_reviewed_at + allergens_reviewed_by to the
//     caller's email (same identity source every other write in this
//     file uses - `requireOwnerApi` -> `gate.email`)
//   - emits one pr_events row `ingredient_allergens_set`
//
// Body: { ingredientId, allergens: string[] }
//
// A re-confirm overwrites and emits a fresh audit row. There is no
// lock; a confirmed ingredient can be re-opened and changed. See
// setIngredientAllergens in src/lib/reviewWrites.ts.
//
// Follows the same action-dispatch pattern as /api/review/set-resale:
// requireOwnerApi, serviceClient, delegate to the helper, mirror
// error -> 400 and exception -> 500.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientAllergens } from "@/lib/reviewWrites";
import { ALLERGENS, normalizeAllergens } from "@/lib/ingredients/allergens";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; allergens?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const ingredientId = body.ingredientId;
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });

  const raw = body.allergens;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "allergens must be an array" }, { status: 400 });
  }
  // normalizeAllergens drops anything not in the canonical nine. If
  // the client sent something extraneous, that is a wire-level
  // problem - reject rather than silently writing a subset.
  const normalized = normalizeAllergens(raw);
  if (normalized.length !== raw.length) {
    const bad = (raw as unknown[]).filter((v) => !(ALLERGENS as readonly string[]).includes(String(v)));
    return NextResponse.json(
      { error: `allergens contains unknown value(s): ${bad.map(String).join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const client = serviceClient();
    const result = await setIngredientAllergens(client, {
      ingredientId,
      allergens: normalized,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
