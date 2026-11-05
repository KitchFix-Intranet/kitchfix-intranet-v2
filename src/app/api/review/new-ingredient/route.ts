import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { splitToNewIngredient, confirmItems } from "@/lib/reviewWrites";
import { SUPER_CATEGORIES, type SuperCategory } from "@/lib/ingredients/categories";

export const dynamic = "force-dynamic";

const SUPER_SET = new Set<string>(SUPER_CATEGORIES);

// Create a new ingredient from a subset of a review group AND reassign
// the chosen items onto it as link_status='proposed'. This is a SPLIT
// action, not a confirm - the moved items appear under the new
// ingredient's own card in the queue and the user confirms there as a
// separate step. See splitToNewIngredient() for the full write set.
//
// category is REQUIRED by the new-ingredient form (step 5), but we
// accept null here so legacy / recovery callers that explicitly want
// "Needs category" can still create one; the form prevents users from
// submitting without a category.
export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: {
    name?: string;
    parent?: string | null;
    category?: string | null;
    itemIds?: string[];
    // Q2 §1: create-and-confirm. When true, the route runs
    // confirmItems() on the moved items in the same request so the
    // user does not have to find the new card and confirm there.
    // Default false preserves pre-Q2 behaviour exactly.
    confirm?: boolean;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const name = (body.name ?? "").trim();
  const parent = body.parent ? String(body.parent).trim() : null;
  const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (name.length < 2) return NextResponse.json({ error: "name required" }, { status: 400 });

  const rawCat = body.category;
  let category: SuperCategory | null;
  if (rawCat === null || rawCat === undefined || rawCat === "") {
    category = null;
  } else if (typeof rawCat === "string" && SUPER_SET.has(rawCat)) {
    category = rawCat as SuperCategory;
  } else {
    return NextResponse.json({ error: "unknown category" }, { status: 400 });
  }

  try {
    const client = serviceClient();
    const result = await splitToNewIngredient(client, {
      name,
      parent,
      category,
      itemIds,
      actorEmail: gate.email,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    // Q2 §1: run confirm in the same request when asked. Partial-
    // atomicity: if confirmItems throws, the create+move already
    // landed and the items sit as link_status='proposed' on the new
    // master - identical to the no-confirm path's success state, so
    // the user can retry confirm by opening the new card. We return
    // ok:false with the error so the panel toasts; the new master is
    // NOT rolled back (that's the pre-Q2 behaviour).
    if (body.confirm === true && result.ingredientId && result.moved > 0) {
      try {
        const confirmResult = await confirmItems(client, {
          ingredientId: result.ingredientId,
          itemIds,
          actorEmail: gate.email,
        });
        return NextResponse.json({
          ok: true,
          ingredientId: result.ingredientId,
          moved: result.moved,
          confirmed: confirmResult.confirmed,
          usd: confirmResult.usd,
          movedToResale: confirmResult.movedToResale,
          confirmErrors: confirmResult.errors.length > 0 ? confirmResult.errors : undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({
          error: `Created "${name}" but confirm failed: ${msg}. Open the new card in the queue to confirm manually.`,
        }, { status: 500 });
      }
    }
    return NextResponse.json({
      ok: true,
      ingredientId: result.ingredientId,
      moved: result.moved,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
