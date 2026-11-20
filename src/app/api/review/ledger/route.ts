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
  // T5b ruling 10: on Show more pages we also name the item. One
  // batched read of pr_vendor_items across every mentioned id on
  // the page keeps the total queries to this handler at two (plus
  // the events themselves).
  const itemIds = new Set<string>();
  for (const e of rows) {
    if (e.entity_type === "ingredient") ingIds.add(e.entity_id);
    if (e.entity_type === "vendor_item") itemIds.add(e.entity_id);
    const after = e.after ?? {};
    if (typeof after.ingredient_id === "string") ingIds.add(after.ingredient_id);
    const afterIds = Array.isArray(after.item_ids) ? (after.item_ids as unknown[]) : [];
    for (const v of afterIds) if (typeof v === "string") itemIds.add(v);
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
  const itemNameById = new Map<string, string>();
  const itemArr = Array.from(itemIds);
  if (itemArr.length > 0) {
    const { data: vi } = await client
      .from("pr_vendor_items")
      .select("id,description_key,name")
      .in("id", itemArr);
    for (const r of (vi ?? []) as Array<{ id: string; description_key: string | null; name: string | null }>) {
      const n = (r.description_key ?? r.name ?? "").trim();
      if (n.length > 0) itemNameById.set(r.id, n);
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
    let itemCount = asNum(e.after?.count)
      || (Array.isArray(e.after?.item_ids) ? (e.after!.item_ids as unknown[]).length : 0)
      || (Array.isArray(e.after?.items) ? (e.after!.items as unknown[]).length : 0);
    // T5b ruling 10: pre-T4 item-scoped events carry neither count
    // nor item_ids. One event is one item by convention; treat the
    // entity_id as the single mention.
    if (itemCount === 0 && e.entity_type === "vendor_item") itemCount = 1;
    const singleItemName =
      itemCount === 1
        ? (Array.isArray(e.after?.item_ids) && typeof (e.after!.item_ids as unknown[])[0] === "string"
            ? itemNameById.get((e.after!.item_ids as string[])[0]) ?? null
            : null)
          ?? (e.entity_type === "vendor_item" ? itemNameById.get(e.entity_id) ?? null : null)
        : null;
    const label = labelFor(e.kind, e.after);
    const text = textFor(e.kind, ingredientName, itemCount, e.after, singleItemName);
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
  singleItemName: string | null,
): string {
  // T5b ruling 10: the bold subject is the item's current description
  // on a one-item decision, and the ingredient (or a count) on a
  // decision on several items. "Item" is the floor when the item was
  // removed. Show more pages return a stringified text; the client
  // renders it in the same frame as the first page.
  const items = itemCount === 1 ? "1 item" : `${itemCount} items`;
  const one = itemCount === 1;
  const subject = one ? (singleItemName ?? "Item") : ingredientName;
  switch (kind) {
    case "review_confirm": {
      const usd = asNum(after?.usd);
      return one
        ? `${subject} · to ${ingredientName} · $${fmtUsdLong(usd).replace(/^\$/, "")}`
        : `${ingredientName} · ${items} · $${fmtUsdLong(usd).replace(/^\$/, "")}`;
    }
    case "review_undo": return one ? subject : `${items} reversed`;
    case "review_notfood":
    case "review_oneoff":
    case "review_keep_separate":
    case "review_archive":
      return one ? subject : items;
    case "review_resale":
      return one ? `${subject} · to Retail` : items;
    case "review_restore": return "1 item back to not matched yet";
    case "review_relink":
      return one
        ? `${subject} · to ${ingredientName}`
        : `${ingredientName} · ${items}`;
    case "ingredient_created":
      return `New ingredient ${typeof after?.name === "string" ? after.name : ingredientName}.`;
    case "ingredient_split_create":
      return `${typeof after?.name === "string" ? after.name : ingredientName} · ${items}`;
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
