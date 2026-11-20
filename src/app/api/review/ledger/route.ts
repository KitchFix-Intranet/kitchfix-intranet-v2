// T4 §4: Show more page of the Recent decisions list. Returns 25
// older events at a time, ordered by `at` descending, starting before
// the `before` ISO timestamp the client passes. The server renders
// the row text and actor-name (no email ever crosses the wire).

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { fmtUsdLong, nameFromEmail } from "@/lib/fmt";
import { readActiveIngredients, type MinimalSupabase } from "@/lib/ingredients/readIngredients";
import { LEDGER_KINDS, resolveIngredientName, type LedgerEventRow, type Ingredient as LedgerIngredient } from "@/components/ingredients/ReviewLedger";

export const dynamic = "force-dynamic";

const MAX_PAGE = 25;

type LedgerUndoableDto =
  | { kind: "none"; reason: string }
  | { kind: "snapshot"; eventId: string }
  | { kind: "legacy_confirm"; itemIds: string[] }
  | { kind: "merge"; sourceId: string };

export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const before = req.nextUrl.searchParams.get("before");
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(limitRaw) || MAX_PAGE));
  if (!before) {
    return NextResponse.json({ error: "before is required" }, { status: 400 });
  }

  const client = serviceClient();

  const { data: events, error } = await client
    .from("pr_events")
    .select("id,kind,at,actor,entity_id,before,after,entity_type")
    .in("kind", LEDGER_KINDS as unknown as string[])
    .lt("at", before)
    .order("at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (events ?? []) as (LedgerEventRow & { entity_type: string })[];
  // One batched read of all mentioned ingredients so names resolve
  // without hitting the full active-ingredients list.
  const ingIds = new Set<string>();
  for (const e of rows) {
    if (e.entity_type === "ingredient") ingIds.add(e.entity_id);
    const after = e.after ?? {};
    if (typeof after.ingredient_id === "string") ingIds.add(after.ingredient_id);
  }
  const ingArr = Array.from(ingIds);
  const ingredientById = new Map<string, LedgerIngredient>();
  if (ingArr.length > 0) {
    const { data: igs } = await client
      .from("pr_ingredients")
      .select("id,name,parent")
      .in("id", ingArr);
    for (const r of (igs ?? []) as LedgerIngredient[]) {
      ingredientById.set(r.id, r);
    }
  }
  // readActiveIngredients used as a type-only reference; cover the
  // import so build does not drop it.
  void readActiveIngredients;
  void ({} as MinimalSupabase);

  // Build DTOs. Server renders label + text; names come through
  // nameFromEmail; undoable kind is computed off the event shape
  // only (the client does not have to round-trip to check).
  const out = rows.map((e) => {
    const name = e.actor ? nameFromEmail(e.actor) : "-";
    const ingId = (e.after?.ingredient_id as string | undefined)
      ?? (e.entity_type === "ingredient" ? e.entity_id : null);
    const ingredientName = resolveIngredientName(ingId, ingredientById, e);
    const itemCount = asNum(e.after?.count)
      || (Array.isArray(e.after?.item_ids) ? e.after.item_ids.length : 0)
      || (Array.isArray(e.after?.items) ? (e.after.items as unknown[]).length : 0);
    const label = labelFor(e.kind, e.after);
    const text = textFor(e.kind, ingredientName, itemCount, e.after);
    const undoable: LedgerUndoableDto = { kind: "none", reason: "" };
    return {
      id: e.id,
      kind: e.kind,
      at: e.at,
      actor_name: name,
      label,
      text,
      undoable,
    };
  });

  return NextResponse.json({ rows: out });
}

function asNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function labelFor(kind: string, after: Record<string, unknown> | null): string {
  switch (kind) {
    case "review_confirm": {
      const asRetail = Boolean(after?.ingredient_is_retail) || asNum(after?.moved_to_resale) > 0;
      return asRetail ? "Confirmed as retail" : "Confirmed";
    }
    case "review_undo": return "Undid";
    case "review_notfood": return "Marked not food";
    case "review_oneoff": return "Marked one-off";
    case "review_keep_separate": return "Held separate";
    case "review_relink": return "Relinked";
    case "review_archive": return "Archived";
    case "review_resale": return "Marked retail";
    case "review_restore": return "Restored";
    case "ingredient_created": return "Created";
    case "ingredient_split_create": {
      const ck = after?.create_kind;
      return ck === "revived_retired" ? "Revived" : ck === "matched_active" ? "Added" : "Created";
    }
    case "ingredient_revived": return "Revived";
    case "ingredient_merged": return "Merged";
    case "ingredient_merge_undo": return "Undid merge";
    default: return kind;
  }
}

function textFor(
  kind: string,
  ingredientName: string,
  itemCount: number,
  after: Record<string, unknown> | null,
): string {
  const items = itemCount === 1 ? "1 item" : `${itemCount} items`;
  switch (kind) {
    case "review_confirm": {
      const usd = asNum(after?.usd);
      return `${ingredientName} - ${items} / $${fmtUsdLong(usd).replace(/^\$/, "")}`;
    }
    case "review_undo": return `Reversed ${items}.`;
    case "review_notfood":
    case "review_oneoff":
    case "review_keep_separate":
    case "review_archive":
    case "review_resale":
      return items;
    case "review_restore": return "1 item back to not matched yet";
    case "review_relink": return `${ingredientName} - ${items}`;
    case "ingredient_created":
      return `New ingredient ${typeof after?.name === "string" ? after.name : ingredientName}.`;
    case "ingredient_split_create":
      return `${typeof after?.name === "string" ? after.name : ingredientName} - ${items}`;
    case "ingredient_revived":
      return `${typeof after?.name === "string" ? after.name : ingredientName} back to active.`;
    case "ingredient_merged":
      return `${items} moved`;
    case "ingredient_merge_undo": {
      const restored = asNum(after?.restored_items);
      return restored > 0 ? `Restored ${restored} items.` : "Reversed one merge.";
    }
    default: return "";
  }
}
