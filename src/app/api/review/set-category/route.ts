import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { setIngredientCategory } from "@/lib/reviewWrites";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";

export const dynamic = "force-dynamic";

const SUPER_SET = new Set<string>(SUPER_CATEGORIES);

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { ingredientId?: string; category?: string | null; parent?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ingredientId = body.ingredientId;
  if (!ingredientId) return NextResponse.json({ error: "ingredientId required" }, { status: 400 });

  // Validate category against the canonical SUPER_CATEGORIES set; null is
  // a valid "Needs category" state.
  const rawCat = body.category;
  let category: SuperCategory | null;
  if (rawCat === null || rawCat === undefined || rawCat === "") {
    category = null;
  } else if (typeof rawCat === "string" && SUPER_SET.has(rawCat)) {
    category = rawCat as SuperCategory;
  } else {
    return NextResponse.json({ error: "unknown category" }, { status: 400 });
  }

  const parent = body.parent === null || body.parent === undefined ? null : String(body.parent);

  try {
    const client = serviceClient();
    const result = await setIngredientCategory(client, {
      ingredientId,
      category,
      parent,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
