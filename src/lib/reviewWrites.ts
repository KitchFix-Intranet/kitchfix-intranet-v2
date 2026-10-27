// Shared write helpers for the review-queue API routes. Server-only, no
// React. The learning-loop write (pr_ingredient_aliases) goes with every
// confirm so the matcher can auto-handle the same description_key next
// time (future matcher upgrade), and the vendor-items table flips to
// link_status='confirmed' which coverage already counts in
// pr_v_overview_totals.

import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryForParent, type SuperCategory } from "@/lib/ingredients/categories";

export type ConfirmResult = {
  confirmed: number;
  usd: number;
  errors: string[];
};

type ItemRow = {
  id: string;
  name: string;
  description_key: string;
  usd_12m: number | null;
  link_status: string;
  ingredient_id: string | null;
};

async function readItems(client: SupabaseClient, itemIds: string[]): Promise<ItemRow[]> {
  if (itemIds.length === 0) return [];
  const out: ItemRow[] = [];
  const page = 100;
  for (let i = 0; i < itemIds.length; i += page) {
    const slice = itemIds.slice(i, i + page);
    const { data, error } = await client
      .from("pr_vendor_items")
      .select("id,name,description_key,usd_12m,link_status,ingredient_id")
      .in("id", slice);
    if (error) throw error;
    out.push(...((data ?? []) as ItemRow[]));
  }
  return out;
}

// Confirm = write golden link + learned alias + flip link_status to
// 'confirmed'. The three-write sequence is ordered so a mid-crash leaves
// the row in a state the next retry can finish cleanly:
//   1. golden link (upsert on vendor_item_id)
//   2. link_status='confirmed'
//   3. pr_ingredient_aliases (upsert on (alias_norm, kind='manual'))
// The pr_events log lands at the end with the full counts.
//
// pr_ingredient_aliases.kind only allows ('vendor','legacy','site','rename',
// 'manual'); the step-5 spec called this 'learned' but the schema check
// doesn't allow a new value without a migration. 'manual' fits the
// semantic ("a human made this decision via confirm") and is the value we
// write. See docs/GOTCHAS.md if we introduce a 'learned' kind later.
export async function confirmItems(
  client: SupabaseClient,
  args: { ingredientId: string; itemIds: string[]; actorEmail: string }
): Promise<ConfirmResult> {
  const { ingredientId, itemIds, actorEmail } = args;
  const result: ConfirmResult = { confirmed: 0, usd: 0, errors: [] };
  if (itemIds.length === 0) return result;

  // Validate ingredient exists + is active (not merged).
  const { data: ing, error: ingErr } = await client
    .from("pr_ingredients")
    .select("id,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (ingErr) throw ingErr;
  if (!ing || (ing as { status: string }).status === "merged") {
    throw new Error("Ingredient not found or merged");
  }

  const rows = await readItems(client, itemIds);
  const confirmable = rows.filter((r) => r.link_status === "proposed");

  // Golden links. Plain UNIQUE on (vendor_item_id) already enforces one
  // row per vendor item; upsert on that constraint keeps a confirm ->
  // undo -> re-confirm cycle mutating the same row (revoked_at:null ->
  // now() -> null). revoked_at:null in the payload reactivates a prior
  // revoke; verified_by + verified_at retake the newest confirm.
  const nowIso = new Date().toISOString();
  const golden = confirmable.map((r) => ({
    vendor_item_id: r.id,
    ingredient_id: ingredientId,
    verified_by: actorEmail,
    verified_at: nowIso,
    revoked_at: null,
  }));
  if (golden.length > 0) {
    const { error } = await client
      .from("pr_golden_links")
      .upsert(golden, { onConflict: "vendor_item_id" });
    if (error) throw error;
  }

  // Flip link_status + lock ingredient_id to the confirmed target. Guard
  // with .eq('link_status','proposed') so a race against the UI never
  // overwrites a human-touched state.
  for (const r of confirmable) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        ingredient_id: ingredientId,
        link_status: "confirmed",
        link_confidence: "high",
        link_reason: `confirmed:${actorEmail}`,
      })
      .eq("id", r.id)
      .eq("link_status", "proposed");
    if (error) {
      result.errors.push(`update ${r.id}: ${error.message}`);
      continue;
    }
    result.confirmed += 1;
    result.usd += Number(r.usd_12m ?? 0);
  }

  // Learned aliases - one per unique description_key. Upsert on
  // (alias_norm, kind) which the schema already uniques.
  const aliasRows = confirmable
    .filter((r) => r.description_key && r.description_key.length > 0)
    .map((r) => ({
      ingredient_id: ingredientId,
      alias_text: r.name,
      alias_norm: r.description_key,
      kind: "manual",
      // Reactivate a prior revoke. The plain UNIQUE on (alias_norm, kind)
      // forces one row per alias; the upsert UPDATE clears revoked_at and
      // can repoint ingredient_id if the alias is reused for a different
      // ingredient after a prior undo.
      revoked_at: null,
    }));
  // Dedupe by alias_norm within this call so the upsert never carries
  // conflicting rows in a single request.
  const seen = new Set<string>();
  const uniqueAliasRows = aliasRows.filter((a) => {
    if (seen.has(a.alias_norm)) return false;
    seen.add(a.alias_norm);
    return true;
  });
  if (uniqueAliasRows.length > 0) {
    const { error: aErr } = await client
      .from("pr_ingredient_aliases")
      .upsert(uniqueAliasRows, { onConflict: "alias_norm,kind" });
    if (aErr) result.errors.push(`aliases: ${aErr.message}`);
  }

  // Ledger.
  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "review_confirm",
    after: {
      item_ids: confirmable.map((r) => r.id),
      confirmed: result.confirmed,
      usd: Math.round(result.usd),
      aliases: uniqueAliasRows.length,
    },
    actor: actorEmail,
  });

  return result;
}

export async function markNotFood(
  client: SupabaseClient,
  args: { itemIds: string[]; actorEmail: string }
): Promise<{ marked: number; errors: string[] }> {
  const { itemIds, actorEmail } = args;
  const errors: string[] = [];
  let marked = 0;
  for (const id of itemIds) {
    // Set link_reason to 'notfood:' and link_status='rejected' so the
    // matcher skips (link_status != 'none') AND the item visibly drops
    // out of the proposed queue. We do NOT flip is_food - that's intake's
    // call, and a human disagreement with the AI shouldn't retro-rewrite
    // the intake classification.
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        link_status: "rejected",
        link_reason: `notfood:${actorEmail}`,
      })
      .eq("id", id)
      .in("link_status", ["proposed", "none"]);
    if (error) {
      errors.push(`${id}: ${error.message}`);
      continue;
    }
    marked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: id,
      kind: "review_notfood",
      actor: actorEmail,
    });
  }
  return { marked, errors };
}

export async function keepSeparate(
  client: SupabaseClient,
  args: { itemIds: string[]; actorEmail: string }
): Promise<{ marked: number; errors: string[] }> {
  const { itemIds, actorEmail } = args;
  const errors: string[] = [];
  let marked = 0;
  // "Keep separate" = don't propose this item into the current group ever
  // again. We write link_status='rejected' + link_reason='keep_separate'
  // so the matcher (which only reads link_status='none') never looks at
  // it. The item appears on vendor-items with a Rejected pill. If Kevin
  // later wants to re-propose it (to a different ingredient), there is a
  // Relink path on the vendor-item drawer that resets link_status.
  for (const id of itemIds) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        link_status: "rejected",
        link_reason: `keep_separate:${actorEmail}`,
      })
      .eq("id", id)
      .in("link_status", ["proposed", "none"]);
    if (error) {
      errors.push(`${id}: ${error.message}`);
      continue;
    }
    marked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: id,
      kind: "review_keep_separate",
      actor: actorEmail,
    });
  }
  return { marked, errors };
}

export async function relinkItems(
  client: SupabaseClient,
  args: { ingredientId: string; itemIds: string[]; actorEmail: string }
): Promise<{ relinked: number; errors: string[] }> {
  const { ingredientId, itemIds, actorEmail } = args;
  const errors: string[] = [];
  let relinked = 0;

  // Validate ingredient.
  const { data: ing, error: ingErr } = await client
    .from("pr_ingredients")
    .select("id,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (ingErr) throw ingErr;
  if (!ing || (ing as { status: string }).status === "merged") {
    throw new Error("Ingredient not found or merged");
  }

  for (const id of itemIds) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        ingredient_id: ingredientId,
        link_reason: `relinked:${actorEmail}`,
      })
      .eq("id", id)
      .eq("link_status", "proposed");
    if (error) {
      errors.push(`${id}: ${error.message}`);
      continue;
    }
    relinked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: id,
      kind: "review_relink",
      after: { ingredient_id: ingredientId },
      actor: actorEmail,
    });
  }
  return { relinked, errors };
}

// Soft-revoke undo. The pr_ tables grant no DELETE (PR24 never-delete),
// so undo cannot remove rows - it stamps revoked_at on the golden link
// and the learned alias, and flips the vendor item back to 'proposed'.
// Re-confirming the same item mutates the same rows (revoked_at:null in
// the upsert payload), so there is never a duplicate active row.
export async function undoConfirm(
  client: SupabaseClient,
  args: { itemId: string; actorEmail: string }
): Promise<{ ok: boolean; error?: string }> {
  const { itemId, actorEmail } = args;

  // Read the item + its ingredient / description_key.
  const { data: itm } = await client
    .from("pr_vendor_items")
    .select("id,description_key,ingredient_id,link_status")
    .eq("id", itemId)
    .maybeSingle();
  if (!itm) return { ok: false, error: "Item not found" };
  const row = itm as { id: string; description_key: string; ingredient_id: string | null; link_status: string };
  if (row.link_status !== "confirmed") return { ok: false, error: "Item is not confirmed; nothing to undo" };

  const nowIso = new Date().toISOString();

  // Soft-revoke the active golden link for this vendor item. No DELETE.
  const { error: revErr } = await client
    .from("pr_golden_links")
    .update({ revoked_at: nowIso })
    .eq("vendor_item_id", itemId)
    .is("revoked_at", null);
  if (revErr) return { ok: false, error: revErr.message };

  // Flip the item back to proposed - this is what drives coverage + the
  // review queue back. Keep ingredient_id so the card still shows the
  // correct target when the item reappears in the queue.
  const { error: upErr } = await client
    .from("pr_vendor_items")
    .update({
      link_status: "proposed",
      link_reason: `undo:${actorEmail}`,
    })
    .eq("id", itemId)
    .eq("link_status", "confirmed");
  if (upErr) return { ok: false, error: upErr.message };

  // Soft-revoke the learned alias on this description_key - but only if
  // no OTHER confirmed item on the same (description_key, ingredient_id)
  // still relies on it. A two-vendor group's alias survives one undo.
  if (row.ingredient_id && row.description_key) {
    const { count } = await client
      .from("pr_vendor_items")
      .select("id", { count: "exact", head: true })
      .eq("link_status", "confirmed")
      .eq("ingredient_id", row.ingredient_id)
      .eq("description_key", row.description_key);
    if ((count ?? 0) === 0) {
      const { error: aliasErr } = await client
        .from("pr_ingredient_aliases")
        .update({ revoked_at: nowIso })
        .eq("alias_norm", row.description_key)
        .eq("kind", "manual")
        .eq("ingredient_id", row.ingredient_id)
        .is("revoked_at", null);
      if (aliasErr) {
        // Non-fatal - the undo already landed; the alias will keep
        // pointing to the ingredient until someone else revokes it.
        // Log it so we see it in Vercel runtime; don't break the undo.
        // eslint-disable-next-line no-console
        console.error(`undoConfirm alias revoke failed: ${aliasErr.message}`);
      }
    }
  }

  await client.from("pr_events").insert({
    entity_type: "vendor_item",
    entity_id: itemId,
    kind: "review_undo",
    actor: actorEmail,
  });

  return { ok: true };
}

export async function createIngredient(
  client: SupabaseClient,
  args: { name: string; parent: string | null; actorEmail: string }
): Promise<{ id: string }> {
  const trimmed = args.name.trim();
  if (trimmed.length < 2) throw new Error("Ingredient name is required");
  const nameNorm = trimmed.toLowerCase().replace(/\s+/g, " ");

  // Try to find an existing active ingredient by name_norm first.
  const { data: existing } = await client
    .from("pr_ingredients")
    .select("id")
    .eq("name_norm", nameNorm)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return { id: (existing as { id: string }).id };

  // base_unit is required by the schema (lb|each|gal|dozen). "each" is the
  // safest default - the ingredient admin surface in a later step lets
  // the user refine it. category is DERIVED from parent via the
  // canonical src/lib/ingredients/categories map; null (unmapped parent)
  // is intentional and surfaces as "Needs category" - never guess.
  const parent = args.parent?.trim() || null;
  const category = categoryForParent(parent);
  const insert = {
    name: trimmed,
    name_norm: nameNorm,
    parent,
    category,
    base_unit: "each",
    status: "active",
    created_by: args.actorEmail,
  };
  const { data, error } = await client
    .from("pr_ingredients")
    .insert(insert)
    .select("id")
    .single();
  if (error) throw error;
  const id = (data as { id: string }).id;

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: id,
    kind: "ingredient_created",
    after: { name: trimmed, parent, category },
    actor: args.actorEmail,
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Detail-panel edits (step 5): rename, category/sub, resale, pack override.
// ---------------------------------------------------------------------------

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Rename an ingredient. The old name is preserved as a `kind='rename'`
// alias so that any future vendor-item whose description_key matches the
// old name_norm auto-routes to the renamed ingredient (same ingredient_id;
// no un-link). The alias insert is an upsert on the schema's
// unique (alias_norm, kind) index - if the old norm was already a
// rename-alias for some other ingredient, the latest decision wins.
export async function renameIngredient(
  client: SupabaseClient,
  args: { ingredientId: string; newName: string; actorEmail: string }
): Promise<{ ok: boolean; error?: string; aliasWritten: boolean }> {
  const { ingredientId, newName, actorEmail } = args;
  const trimmed = newName.trim();
  if (trimmed.length < 2) return { ok: false, error: "Name is too short", aliasWritten: false };
  const newNorm = normName(trimmed);

  // Load current for the before/after + the old-name alias.
  const { data: cur, error: curErr } = await client
    .from("pr_ingredients")
    .select("id,name,name_norm,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message, aliasWritten: false };
  if (!cur) return { ok: false, error: "Ingredient not found", aliasWritten: false };
  const row = cur as { id: string; name: string; name_norm: string; status: string };
  if (row.status === "merged") return { ok: false, error: "Ingredient is merged", aliasWritten: false };
  if (row.name_norm === newNorm) {
    // Same name after normalization - no-op success, no event, no alias.
    return { ok: true, aliasWritten: false };
  }

  // Collision guard: live unique index pr_ingredients_name_norm_live_uq
  // where status <> 'merged' would reject anyway, but surface a friendly
  // error before the write.
  const { data: collision } = await client
    .from("pr_ingredients")
    .select("id")
    .eq("name_norm", newNorm)
    .neq("status", "merged")
    .neq("id", ingredientId)
    .maybeSingle();
  if (collision) {
    return { ok: false, error: "Another active ingredient already uses that name", aliasWritten: false };
  }

  const { error: upErr } = await client
    .from("pr_ingredients")
    .update({ name: trimmed, name_norm: newNorm, updated_at: new Date().toISOString() })
    .eq("id", ingredientId);
  if (upErr) return { ok: false, error: upErr.message, aliasWritten: false };

  // Preserve the old name as a rename-alias so matcher auto-handles the
  // same description_key on future intakes. kind='rename' is already in
  // the pr_ingredient_aliases CHECK; the upsert on (alias_norm, kind)
  // repoints the alias to this ingredient if the old norm was previously
  // claimed by someone else.
  let aliasWritten = false;
  const { error: aErr } = await client
    .from("pr_ingredient_aliases")
    .upsert(
      {
        ingredient_id: ingredientId,
        alias_text: row.name,
        alias_norm: row.name_norm,
        kind: "rename",
      },
      { onConflict: "alias_norm,kind" }
    );
  if (aErr) {
    // Non-fatal - the rename landed. Log the detail in pr_events so we
    // know the auto-relink magic may not pick up the old name.
    // eslint-disable-next-line no-console
    console.error(`rename alias upsert failed: ${aErr.message}`);
  } else {
    aliasWritten = true;
  }

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_renamed",
    before: { name: row.name, name_norm: row.name_norm },
    after: { name: trimmed, name_norm: newNorm, alias_written: aliasWritten },
    actor: actorEmail,
  });

  return { ok: true, aliasWritten };
}

// Set an ingredient's super-category + parent (sub-category). Both are
// nullable - null category = "Needs category". Parent is a free text
// bucket (new parents allowed; the categoryForParent map in
// src/lib/ingredients/categories.ts stays in sync with the SQL migration
// map, but a parent not in the map just means category stays null unless
// the user picked one explicitly).
export async function setIngredientCategory(
  client: SupabaseClient,
  args: {
    ingredientId: string;
    category: SuperCategory | null;
    parent: string | null;
    actorEmail: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const { ingredientId, category, parent, actorEmail } = args;
  const parentTrim = parent?.trim() || null;

  const { data: cur, error: curErr } = await client
    .from("pr_ingredients")
    .select("id,category,parent,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message };
  if (!cur) return { ok: false, error: "Ingredient not found" };
  const row = cur as { id: string; category: string | null; parent: string | null; status: string };
  if (row.status === "merged") return { ok: false, error: "Ingredient is merged" };

  const { error: upErr } = await client
    .from("pr_ingredients")
    .update({ category, parent: parentTrim, updated_at: new Date().toISOString() })
    .eq("id", ingredientId);
  if (upErr) return { ok: false, error: upErr.message };

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_category_set",
    before: { category: row.category, parent: row.parent },
    after: { category, parent: parentTrim },
    actor: actorEmail,
  });

  return { ok: true };
}

// Toggle an ingredient between the recipe-coverage bucket and the resale
// bucket. Every confirmed vendor item that points to this ingredient
// moves with it; the pr_v_overview_* views do the resale split by
// joining on this flag.
export async function setIngredientResale(
  client: SupabaseClient,
  args: { ingredientId: string; resale: boolean; actorEmail: string }
): Promise<{ ok: boolean; error?: string }> {
  const { ingredientId, resale, actorEmail } = args;

  const { data: cur, error: curErr } = await client
    .from("pr_ingredients")
    .select("id,resale,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message };
  if (!cur) return { ok: false, error: "Ingredient not found" };
  const row = cur as { id: string; resale: boolean; status: string };
  if (row.status === "merged") return { ok: false, error: "Ingredient is merged" };
  if (row.resale === resale) return { ok: true };

  const { error: upErr } = await client
    .from("pr_ingredients")
    .update({ resale, updated_at: new Date().toISOString() })
    .eq("id", ingredientId);
  if (upErr) return { ok: false, error: upErr.message };

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_resale_set",
    before: { resale: row.resale },
    after: { resale },
    actor: actorEmail,
  });

  return { ok: true };
}

// Manual pack-size entry for an "-/case" item. We stamp the user's text
// into pack_text + billed_unit (where previously null), snapshot the full
// payload + actor + timestamp into pack_override jsonb (so the override
// is auditable + queryable), and leave pack_qty/pack_size/pack_uom null
// (true parsing is step 3's job). pack_state flips to 'ok' - the human
// attests the value is known. The jsonb presence of pack_override is the
// "manually entered" flag that renders a badge on the row.
export async function setVendorItemPackOverride(
  client: SupabaseClient,
  args: {
    itemId: string;
    packText: string;
    billedUnit: string | null;
    note: string | null;
    actorEmail: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const { itemId, packText, billedUnit, note, actorEmail } = args;
  const packTrim = packText.trim();
  if (packTrim.length < 1) return { ok: false, error: "Pack text is required" };

  const { data: cur, error: curErr } = await client
    .from("pr_vendor_items")
    .select("id,pack_text,billed_unit,pack_state,pack_override,status")
    .eq("id", itemId)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message };
  if (!cur) return { ok: false, error: "Item not found" };
  const row = cur as {
    id: string;
    pack_text: string | null;
    billed_unit: string | null;
    pack_state: string;
    pack_override: unknown;
    status: string;
  };

  const nowIso = new Date().toISOString();
  const unitTrim = billedUnit?.trim() || null;
  const noteTrim = note?.trim() || null;
  const override = {
    pack_text: packTrim,
    billed_unit: unitTrim,
    note: noteTrim,
    by: actorEmail,
    at: nowIso,
  };

  const { error: upErr } = await client
    .from("pr_vendor_items")
    .update({
      pack_text: packTrim,
      billed_unit: unitTrim ?? row.billed_unit,
      pack_state: "ok",
      pack_override: override,
      updated_at: nowIso,
    })
    .eq("id", itemId);
  if (upErr) return { ok: false, error: upErr.message };

  await client.from("pr_events").insert({
    entity_type: "vendor_item",
    entity_id: itemId,
    kind: "pack_override_set",
    before: {
      pack_text: row.pack_text,
      billed_unit: row.billed_unit,
      pack_state: row.pack_state,
      had_override: row.pack_override !== null,
    },
    after: override,
    actor: actorEmail,
  });

  return { ok: true };
}
