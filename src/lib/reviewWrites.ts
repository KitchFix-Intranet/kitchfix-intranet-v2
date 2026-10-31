// Shared write helpers for the review-queue API routes. Server-only, no
// React. The learning-loop write (pr_ingredient_aliases) goes with every
// confirm so the matcher can auto-handle the same description_key next
// time (future matcher upgrade), and the vendor-items table flips to
// link_status='confirmed' which coverage already counts in
// pr_v_overview_totals.

import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryForParent, type SuperCategory } from "@/lib/ingredients/categories";
import { estimateFromOverride } from "@/lib/ingredients/estimate";
import { parsePack } from "@/lib/ingredients/pack";

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

// Mirror of markNotFood for the Retail disposition. Retail = sold as-is
// to players (bottled water, snacks, pre-made sandwiches) - real spend
// but not a recipe ingredient. The two writes together are:
//   - status='resale'       -> the overview views already read this and
//                              bucket the dollars as retail spend
//                              (excluded from recipe coverage).
//   - link_status='rejected', link_reason='resale:<email>'
//                              keeps the matcher (which only reads
//                              link_status='none') from re-proposing
//                              these on the next run, AND the item
//                              visibly drops out of the proposed queue.
// We deliberately do NOT flip is_food - a human disposition doesn't
// retro-rewrite intake's classification (same reasoning as markNotFood).
// Each per-item pr_events row carries the full aggregate (item_ids,
// count, usd, actor) in the after jsonb so a single-event lookup gives
// the complete batch context.
export async function markResale(
  client: SupabaseClient,
  args: { itemIds: string[]; actorEmail: string }
): Promise<{ marked: number; usd: number; errors: string[] }> {
  const { itemIds, actorEmail } = args;
  const errors: string[] = [];
  if (itemIds.length === 0) return { marked: 0, usd: 0, errors };

  // Preload usd_12m for the aggregate `after.usd` field (same pattern
  // confirmItems uses). readItems also surfaces the current link_status
  // so we skip rows that aren't in the queue anymore.
  const rows = await readItems(client, itemIds);
  const eligible = rows.filter((r) => r.link_status === "proposed" || r.link_status === "none");
  const eligibleIds = eligible.map((r) => r.id);
  const totalUsd = eligible.reduce((s, r) => s + Number(r.usd_12m ?? 0), 0);

  let marked = 0;
  for (const r of eligible) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        status: "resale",
        link_status: "rejected",
        link_reason: `resale:${actorEmail}`,
      })
      .eq("id", r.id)
      .in("link_status", ["proposed", "none"]);
    if (error) {
      errors.push(`${r.id}: ${error.message}`);
      continue;
    }
    marked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: r.id,
      kind: "review_resale",
      after: {
        item_ids: eligibleIds,
        count: eligibleIds.length,
        usd: Math.round(totalUsd),
      },
      actor: actorEmail,
    });
  }
  return { marked, usd: Math.round(totalUsd), errors };
}

// Flag toggle. Flag is an ORTHOGONAL marker to disposition - a flagged
// item stays in the queue with its current link_status / status /
// ingredient_id untouched; it's just marked for a second reviewer's
// pass (Britt's #1 ask from the Oct 29 review: a hand-off between two
// reviewers).
// Writes: flagged + flag_note + flagged_by + flagged_at on each item.
// Unflag clears flag_note / flagged_by / flagged_at too. Logs
// pr_events kind='review_flag' or 'review_unflag' per item with the
// batch aggregate in after.
export async function setFlag(
  client: SupabaseClient,
  args: {
    itemIds: string[];
    flagged: boolean;
    note: string | null;
    actorEmail: string;
  }
): Promise<{ marked: number; errors: string[] }> {
  const { itemIds, flagged, note, actorEmail } = args;
  const errors: string[] = [];
  if (itemIds.length === 0) return { marked: 0, errors };

  const noteTrim = note?.trim() || null;
  const nowIso = new Date().toISOString();
  const payload = flagged
    ? {
        flagged: true,
        flag_note: noteTrim,
        flagged_by: actorEmail,
        flagged_at: nowIso,
      }
    : {
        flagged: false,
        flag_note: null,
        flagged_by: null,
        flagged_at: null,
      };

  let marked = 0;
  for (const id of itemIds) {
    const { error } = await client
      .from("pr_vendor_items")
      .update(payload)
      .eq("id", id);
    if (error) {
      errors.push(`${id}: ${error.message}`);
      continue;
    }
    marked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: id,
      kind: flagged ? "review_flag" : "review_unflag",
      after: flagged
        ? { item_ids: itemIds, count: itemIds.length, note: noteTrim }
        : { item_ids: itemIds, count: itemIds.length },
      actor: actorEmail,
    });
  }
  return { marked, errors };
}

// Mirror of markResale for the Archive disposition. Archive = an IS-food
// item that's a one-off or irrelevant purchase - not a recipe ingredient,
// not retail, not "not food." The overview views only count status in
// ('active','resale'), so flipping to 'archived' pulls the item out of
// recipe coverage AND retail automatically; the matcher only reads
// link_status='none' so link_status='rejected' keeps it from being
// re-proposed. No is_food flip (same reasoning as the other dispositions).
// Per-item event carries the full batch aggregate in after.
export async function markArchived(
  client: SupabaseClient,
  args: { itemIds: string[]; actorEmail: string }
): Promise<{ marked: number; usd: number; errors: string[] }> {
  const { itemIds, actorEmail } = args;
  const errors: string[] = [];
  if (itemIds.length === 0) return { marked: 0, usd: 0, errors };

  const rows = await readItems(client, itemIds);
  const eligible = rows.filter((r) => r.link_status === "proposed" || r.link_status === "none");
  const eligibleIds = eligible.map((r) => r.id);
  const totalUsd = eligible.reduce((s, r) => s + Number(r.usd_12m ?? 0), 0);

  let marked = 0;
  for (const r of eligible) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({
        status: "archived",
        link_status: "rejected",
        link_reason: `archived:${actorEmail}`,
      })
      .eq("id", r.id)
      .in("link_status", ["proposed", "none"]);
    if (error) {
      errors.push(`${r.id}: ${error.message}`);
      continue;
    }
    marked += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: r.id,
      kind: "review_archive",
      after: {
        item_ids: eligibleIds,
        count: eligibleIds.length,
        usd: Math.round(totalUsd),
      },
      actor: actorEmail,
    });
  }
  return { marked, usd: Math.round(totalUsd), errors };
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

// Bulk form of undoConfirm. Sequential on purpose - NOT Promise.all.
// undoConfirm decides whether to revoke the learned alias by counting
// the confirmed items still on the same (description_key,
// ingredient_id). That count changes as each item flips to 'proposed',
// so the calls must observe each other's writes. Run in parallel and
// two items sharing a description_key would each see the other as
// still-confirmed, and the alias would survive when it should not.
export async function undoConfirmMany(
  client: SupabaseClient,
  args: { itemIds: string[]; actorEmail: string }
): Promise<{ ok: boolean; undone: number; skipped: number; errors: string[] }> {
  const { itemIds, actorEmail } = args;
  let undone = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const itemId of itemIds) {
    const r = await undoConfirm(client, { itemId, actorEmail });
    if (r.ok) {
      undone += 1;
    } else if (r.error === "Item is not confirmed; nothing to undo") {
      // Benign: already proposed, or someone else got there first.
      skipped += 1;
    } else {
      errors.push(`${itemId}: ${r.error ?? "unknown error"}`);
    }
  }

  return { ok: errors.length === 0, undone, skipped, errors };
}

export async function createIngredient(
  client: SupabaseClient,
  args: {
    name: string;
    parent: string | null;
    actorEmail: string;
    // When provided, honor the user's chosen super-category exactly
    // (even if it disagrees with categoryForParent(parent)). When
    // omitted or undefined, fall back to the parent map default. null
    // is a valid explicit value - "Needs category".
    category?: SuperCategory | null;
  }
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
  // the user refine it. category is EXPLICIT: use the user's chosen
  // value when supplied (step 5 new-ingredient form), else derive from
  // parent. Null is a valid explicit value - the new form prevents it,
  // but legacy callers (e.g. matcher auto-create) may still produce
  // null if the parent is unmapped.
  const parent = args.parent?.trim() || null;
  const category =
    args.category !== undefined ? args.category : categoryForParent(parent);
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

// Split-to-new-ingredient: create a new ingredient AND move the selected
// vendor items onto it, keeping them as link_status='proposed' so they
// appear under the new ingredient's own card in the review queue. Does
// NOT auto-confirm (that was the old behavior; it meant moved items
// vanished out of the queue entirely, which hid the split from Kevin -
// "it still falls under the group I removed it from" / "the one I moved
// disappeared"). Confirm is a separate explicit step on the new card.
//
// link_reason gets a 'split:<actor>' prefix so the matcher / loader
// never routes these back into the old ai-new bucket. Pre-existing
// ai-new link_reason on those items (keyed into the proposed_name
// group) is deliberately overwritten.
export async function splitToNewIngredient(
  client: SupabaseClient,
  args: {
    name: string;
    parent: string | null;
    category: SuperCategory | null;
    itemIds: string[];
    actorEmail: string;
  }
): Promise<{ ok: boolean; error?: string; ingredientId: string | null; moved: number }> {
  const { name, parent, category, itemIds, actorEmail } = args;
  if (name.trim().length < 2) {
    return { ok: false, error: "Ingredient name is required", ingredientId: null, moved: 0 };
  }

  let ingredientId: string;
  try {
    const { id } = await createIngredient(client, {
      name,
      parent,
      category,
      actorEmail,
    });
    ingredientId = id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, ingredientId: null, moved: 0 };
  }

  if (itemIds.length === 0) {
    return { ok: true, ingredientId, moved: 0 };
  }

  // Reassign in one UPDATE guarded on current proposed state so a race
  // doesn't retouch a row the user already confirmed elsewhere.
  const { error, data } = await client
    .from("pr_vendor_items")
    .update({
      ingredient_id: ingredientId,
      link_reason: `split:${actorEmail}`,
    })
    .in("id", itemIds)
    .eq("link_status", "proposed")
    .select("id");
  if (error) {
    return { ok: false, error: error.message, ingredientId, moved: 0 };
  }
  const movedIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_split_create",
    before: { item_ids: itemIds },
    after: { moved_item_ids: movedIds, name, parent, category },
    actor: actorEmail,
  });

  return { ok: true, ingredientId, moved: movedIds.length };
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

// The master's unit of account. Every per-unit price on the Ingredients
// tab is each linked item's stored per_base converted INTO this unit at
// render time, so changing it re-blends that master on the next load -
// no backfill, no stored price column, and setting it back restores the
// previous number exactly. Items whose price is in another dimension
// are dropped from the blend (the `mismatch` issue), which is why a
// master left on the created-by-default 'each' while its items are
// priced per pound shows no price at all.
//
// The caller validates against the schema's CHECK constraint
// (lb|each|gal|dozen); this helper re-checks rather than trusting it,
// because a bad value here would surface as a 500 from Postgres.
const BASE_UNIT_VALUES = new Set(["lb", "each", "gal", "dozen"]);

export async function setIngredientBaseUnit(
  client: SupabaseClient,
  args: { ingredientId: string; baseUnit: string; actorEmail: string }
): Promise<{ ok: boolean; error?: string }> {
  const { ingredientId, actorEmail } = args;
  const baseUnit = String(args.baseUnit ?? "").trim().toLowerCase();
  if (!BASE_UNIT_VALUES.has(baseUnit)) {
    return { ok: false, error: "base unit must be one of lb, each, gal, dozen" };
  }

  const { data: cur, error: curErr } = await client
    .from("pr_ingredients")
    .select("id,base_unit,status")
    .eq("id", ingredientId)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message };
  if (!cur) return { ok: false, error: "Ingredient not found" };
  const row = cur as { id: string; base_unit: string; status: string };
  if (row.status === "merged") return { ok: false, error: "Ingredient is merged" };
  if (row.base_unit === baseUnit) return { ok: true };

  const { error: upErr } = await client
    .from("pr_ingredients")
    .update({ base_unit: baseUnit, updated_at: new Date().toISOString() })
    .eq("id", ingredientId);
  if (upErr) return { ok: false, error: upErr.message };

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: ingredientId,
    kind: "ingredient_base_unit_set",
    before: { base_unit: row.base_unit },
    after: { base_unit: baseUnit },
    actor: actorEmail,
  });

  return { ok: true };
}

// Structured pack-override (Phase 1.8). Replaces the free-text version
// that only stored `{pack_text, billed_unit}`. The editor now captures
// qty/size/uom (non-catch) or $/lb (catch) directly from a UI with
// typed inputs + a UOM dropdown; this helper:
//   1. Reads the item + its latest billed price + its catalog match.
//   2. Computes per-base via estimateFromOverride (reuses the shared
//      base-unit table; no second estimator).
//   3. Writes pack_override jsonb (structured) + pack_qty/pack_size/
//      pack_uom + pack_text (human-readable) + billed_unit + pack_state
//      = 'override' + price_estimate on the target row.
//   4. Propagates the same write to every pr_vendor_items row with the
//      SAME (vendor_id, item_number_norm) - these are the identical
//      vendor SKU, so the pack is by definition the same. Does NOT
//      propagate across different vendors or SKUs even on the same
//      ingredient.
//   5. Logs one pr_events 'pack_override_set' per touched row.
// Idempotent + override-safe (every row carries pack_override after).
// Returns twin count so the UI can show "applied to N matching items".
export type StructuredOverridePayload = {
  catch_weight: boolean;
  qty: number | null;
  size: number | null;
  uom: string | null;
  per_lb: number | null;
  billed_unit: string | null;
  note: string | null;
};

export async function setVendorItemPackOverride(
  client: SupabaseClient,
  args: {
    itemId: string;
    payload: StructuredOverridePayload;
    actorEmail: string;
  }
): Promise<{
  ok: boolean;
  error?: string;
  mainWritten: boolean;
  twins: number;
  perBase: number | null;
  baseUom: string | null;
}> {
  const { itemId, payload, actorEmail } = args;

  // Load the target row (we need vendor_id + item_number_norm for twin
  // propagation; billed_unit + catalog data for the price fallback).
  const { data: itemRow, error: itemErr } = await client
    .from("pr_vendor_items")
    .select("id,vendor_id,item_number,item_number_norm,pack_text,billed_unit,pack_state,pack_override,catch_weight,status")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) return { ok: false, error: itemErr.message, mainWritten: false, twins: 0, perBase: null, baseUom: null };
  if (!itemRow) return { ok: false, error: "Item not found", mainWritten: false, twins: 0, perBase: null, baseUom: null };
  const item = itemRow as {
    id: string;
    vendor_id: string;
    item_number: string | null;
    item_number_norm: string | null;
    pack_text: string | null;
    billed_unit: string | null;
    pack_state: string;
    pack_override: unknown;
    catch_weight: boolean;
    status: string;
  };

  // Fetch latest valid unit_price for the item (billed fallback on the
  // non-catch price path; and for catch-weight when the user doesn't
  // supply per_lb we still null it, we don't invent one here).
  let latestUnitPrice: number | null = null;
  {
    const { data: obsRow } = await client
      .from("pr_price_observations")
      .select("unit_price")
      .eq("vendor_item_id", itemId)
      .is("excluded_reason", null)
      .not("unit_price", "is", null)
      .order("invoice_date", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (obsRow && typeof (obsRow as { unit_price?: unknown }).unit_price === "number") {
      latestUnitPrice = (obsRow as { unit_price: number }).unit_price;
    } else if (obsRow && (obsRow as { unit_price?: unknown }).unit_price != null) {
      const n = Number((obsRow as { unit_price: unknown }).unit_price);
      if (Number.isFinite(n)) latestUnitPrice = n;
    }
  }

  // Catalog match on (vendor_id, item_number_norm).
  let catalogPrice: number | null = null;
  if (item.item_number_norm) {
    const { data: catRow } = await client
      .from("pr_vendor_catalog")
      .select("catalog_price")
      .eq("vendor_id", item.vendor_id)
      .eq("item_number_norm", item.item_number_norm)
      .maybeSingle();
    if (catRow && (catRow as { catalog_price?: unknown }).catalog_price != null) {
      const n = Number((catRow as { catalog_price: unknown }).catalog_price);
      if (Number.isFinite(n) && n > 0) catalogPrice = n;
    }
  }

  // Compute the structured estimate (reuses the shared base-unit table).
  const result = estimateFromOverride({
    catch_weight: payload.catch_weight,
    qty: payload.qty,
    size: payload.size,
    uom: payload.uom?.toUpperCase() ?? null,
    per_lb: payload.per_lb,
    catalog_price: catalogPrice,
    latest_unit_price: latestUnitPrice,
    note: payload.note,
  });

  const nowIso = new Date().toISOString();
  const unitTrim = payload.billed_unit?.trim().toLowerCase() || null;

  // Human-readable pack_text echo of the structured payload - useful for
  // old UI surfaces + legacy JSON exports.
  const packTextEcho = payload.catch_weight
    ? "catch-weight"
    : result.qty != null && result.size != null && result.uom
      ? result.qty === 1
        ? `${result.size} ${result.uom}`
        : `${result.qty}/${result.size} ${result.uom}`
      : item.pack_text ?? "";

  const override = {
    catch_weight: payload.catch_weight,
    qty: result.qty,
    size: result.size,
    uom: result.uom,
    dim: result.dim,
    base_uom: result.base_uom,
    total_base: result.total_base,
    per_lb: payload.catch_weight ? payload.per_lb : null,
    case_price: result.case_price,
    case_price_source: result.case_price_source,
    billed_unit: unitTrim,
    pack_text: packTextEcho,
    note: result.note,
    by: actorEmail,
    at: nowIso,
  };

  const priceEstimate = {
    per_base: result.per_base,
    base_uom: result.base_uom,
    case_price: result.case_price,
    case_price_source: "override" as const,
    pack_source: "override" as const,
    confidence: "override" as const,
    note: result.note,
  };

  const writeTargets: Array<{
    id: string;
    before: Record<string, unknown>;
  }> = [
    {
      id: item.id,
      before: {
        pack_text: item.pack_text,
        billed_unit: item.billed_unit,
        pack_state: item.pack_state,
        had_override: item.pack_override !== null,
      },
    },
  ];

  // Twin propagation: same (vendor_id, item_number_norm) only. We skip
  // when item_number_norm is null (then there's no stable twin key).
  let twins = 0;
  if (item.item_number_norm) {
    const { data: twinRows, error: twinErr } = await client
      .from("pr_vendor_items")
      .select("id,pack_text,billed_unit,pack_state,pack_override")
      .eq("vendor_id", item.vendor_id)
      .eq("item_number_norm", item.item_number_norm)
      .neq("id", item.id);
    if (twinErr) return { ok: false, error: twinErr.message, mainWritten: false, twins: 0, perBase: null, baseUom: null };
    for (const t of (twinRows ?? []) as Array<{
      id: string;
      pack_text: string | null;
      billed_unit: string | null;
      pack_state: string;
      pack_override: unknown;
    }>) {
      writeTargets.push({
        id: t.id,
        before: {
          pack_text: t.pack_text,
          billed_unit: t.billed_unit,
          pack_state: t.pack_state,
          had_override: t.pack_override !== null,
          twin_of: item.id,
        },
      });
      twins += 1;
    }
  }

  let mainWritten = false;
  for (const t of writeTargets) {
    const { error: upErr } = await client
      .from("pr_vendor_items")
      .update({
        pack_text: packTextEcho || null,
        pack_qty: result.qty,
        pack_size: result.size,
        pack_uom: result.uom,
        billed_unit: unitTrim ?? undefined,
        pack_state: "override",
        pack_override: override,
        price_estimate: priceEstimate,
        updated_at: nowIso,
      })
      .eq("id", t.id);
    if (upErr) {
      // First-target failure aborts; twin failures are logged and skipped.
      if (t.id === item.id) {
        return { ok: false, error: upErr.message, mainWritten: false, twins: 0, perBase: null, baseUom: null };
      }
      // eslint-disable-next-line no-console
      console.error(`pack override twin write failed for ${t.id}: ${upErr.message}`);
      continue;
    }
    if (t.id === item.id) mainWritten = true;

    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: t.id,
      kind: "pack_override_set",
      before: t.before,
      after: override,
      actor: actorEmail,
    });
  }

  return {
    ok: mainWritten,
    mainWritten,
    twins,
    perBase: result.per_base,
    baseUom: result.base_uom,
  };
}

// One-time migration for the pre-Phase-1.8 text overrides. These rows
// have pack_override.pack_text + pack_state='ok' but a null per_base.
// We re-parse the text via parsePack and, when it parses high/low,
// convert to the structured shape via estimateFromOverride; when parse
// is 'none', we still flip pack_state='override' with a note so the
// row is permanent, but leave per_base null for Kevin to re-enter.
// Owner-gated through the admin route; idempotent (converted rows have
// pack_override.qty populated so they're skipped on re-run).
export async function migrateTextPackOverrides(
  client: SupabaseClient,
  args: { actorEmail: string }
): Promise<{
  ok: boolean;
  converted: number;
  flagged: number;
  skipped: number;
  samples: Array<{ id: string; result: "converted" | "flagged"; from: string; to?: string }>;
}> {
  const { actorEmail } = args;
  // Pull all rows with a pack_override set.
  const batch = 500;
  let from = 0;
  const samples: Array<{ id: string; result: "converted" | "flagged"; from: string; to?: string }> = [];
  let converted = 0;
  let flagged = 0;
  let skipped = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select("id,vendor_id,item_number_norm,pack_text,billed_unit,pack_state,pack_override,catch_weight")
      .not("pack_override", "is", null)
      .order("id", { ascending: true })
      .range(from, from + batch - 1);
    if (error) return { ok: false, converted, flagged, skipped, samples };
    const rows = (data ?? []) as Array<{
      id: string;
      vendor_id: string;
      item_number_norm: string | null;
      pack_text: string | null;
      billed_unit: string | null;
      pack_state: string;
      pack_override: Record<string, unknown> | null;
      catch_weight: boolean;
    }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const po = r.pack_override ?? {};
      // Skip rows already in the structured shape (idempotent re-run).
      if (po.qty != null || po.catch_weight != null || po.base_uom != null) {
        skipped += 1;
        continue;
      }
      const legacyText = typeof po.pack_text === "string" ? po.pack_text : r.pack_text ?? "";
      const parsed = parsePack(legacyText);

      if (parsed.confidence === "none" || parsed.total_base == null) {
        // Flag for re-entry; keep pack_text so Kevin sees the original
        // in the editor. pack_state flips to 'override' so the backfill
        // skips it from here on.
        const nowIso = new Date().toISOString();
        const newOverride = {
          ...po,
          qty: null,
          size: null,
          uom: null,
          dim: null,
          base_uom: null,
          total_base: null,
          catch_weight: r.catch_weight,
          per_lb: null,
          case_price: null,
          case_price_source: null,
          billed_unit: typeof po.billed_unit === "string" ? po.billed_unit : r.billed_unit,
          pack_text: legacyText,
          note: "override needs re-entry in structured editor (migrated from text)",
          by: actorEmail,
          at: nowIso,
        };
        const priceEstimate = {
          per_base: null,
          base_uom: null,
          case_price: null,
          case_price_source: "override" as const,
          pack_source: "override" as const,
          confidence: "override" as const,
          note: "override needs re-entry in structured editor",
        };
        const { error: upErr } = await client
          .from("pr_vendor_items")
          .update({
            pack_state: "override",
            pack_override: newOverride,
            price_estimate: priceEstimate,
            updated_at: nowIso,
          })
          .eq("id", r.id);
        if (upErr) continue;
        await client.from("pr_events").insert({
          entity_type: "vendor_item",
          entity_id: r.id,
          kind: "pack_override_set",
          before: {
            pack_text: r.pack_text,
            billed_unit: r.billed_unit,
            pack_state: r.pack_state,
            migrated_from: "text",
          },
          after: newOverride,
          actor: actorEmail,
          note: "migration: flagged for re-entry (parse=none)",
        });
        flagged += 1;
        if (samples.length < 20) samples.push({ id: r.id, result: "flagged", from: legacyText });
        continue;
      }

      // Parsed - convert via estimateFromOverride. Pull catalog price
      // for the price-fallback math.
      let catalogPrice: number | null = null;
      if (r.item_number_norm) {
        const { data: catRow } = await client
          .from("pr_vendor_catalog")
          .select("catalog_price")
          .eq("vendor_id", r.vendor_id)
          .eq("item_number_norm", r.item_number_norm)
          .maybeSingle();
        if (catRow && (catRow as { catalog_price?: unknown }).catalog_price != null) {
          const n = Number((catRow as { catalog_price: unknown }).catalog_price);
          if (Number.isFinite(n) && n > 0) catalogPrice = n;
        }
      }
      // Pull latest billed too.
      let latestUnitPrice: number | null = null;
      {
        const { data: obsRow } = await client
          .from("pr_price_observations")
          .select("unit_price")
          .eq("vendor_item_id", r.id)
          .is("excluded_reason", null)
          .not("unit_price", "is", null)
          .order("invoice_date", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (obsRow && (obsRow as { unit_price?: unknown }).unit_price != null) {
          const n = Number((obsRow as { unit_price: unknown }).unit_price);
          if (Number.isFinite(n)) latestUnitPrice = n;
        }
      }

      const result = estimateFromOverride({
        catch_weight: r.catch_weight,
        qty: parsed.qty,
        size: parsed.size,
        uom: parsed.uom,
        per_lb: null, // text overrides never carried a direct $/lb
        catalog_price: catalogPrice,
        latest_unit_price: latestUnitPrice,
        note: `migrated from text override: "${legacyText}"`,
      });
      const nowIso = new Date().toISOString();
      const newOverride = {
        catch_weight: r.catch_weight,
        qty: result.qty,
        size: result.size,
        uom: result.uom,
        dim: result.dim,
        base_uom: result.base_uom,
        total_base: result.total_base,
        per_lb: null,
        case_price: result.case_price,
        case_price_source: result.case_price_source,
        billed_unit: typeof po.billed_unit === "string" ? po.billed_unit : r.billed_unit,
        pack_text: legacyText,
        note: result.note,
        by: actorEmail,
        at: nowIso,
      };
      const packTextEcho =
        result.qty != null && result.size != null && result.uom
          ? result.qty === 1
            ? `${result.size} ${result.uom}`
            : `${result.qty}/${result.size} ${result.uom}`
          : legacyText;
      const priceEstimate = {
        per_base: result.per_base,
        base_uom: result.base_uom,
        case_price: result.case_price,
        case_price_source: "override" as const,
        pack_source: "override" as const,
        confidence: "override" as const,
        note: result.note,
      };
      const { error: upErr } = await client
        .from("pr_vendor_items")
        .update({
          pack_text: packTextEcho,
          pack_qty: result.qty,
          pack_size: result.size,
          pack_uom: result.uom,
          pack_state: "override",
          pack_override: newOverride,
          price_estimate: priceEstimate,
          updated_at: nowIso,
        })
        .eq("id", r.id);
      if (upErr) continue;
      await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: r.id,
        kind: "pack_override_set",
        before: {
          pack_text: r.pack_text,
          billed_unit: r.billed_unit,
          pack_state: r.pack_state,
          migrated_from: "text",
        },
        after: newOverride,
        actor: actorEmail,
        note: `migration: converted from text (parse=${parsed.confidence})`,
      });
      converted += 1;
      if (samples.length < 20) samples.push({ id: r.id, result: "converted", from: legacyText, to: packTextEcho });
    }
    if (rows.length < batch) break;
    from += batch;
  }
  return { ok: true, converted, flagged, skipped, samples };
}

// ---------------------------------------------------------------------------
// Merge two ingredients (step 5): move every vendor item + active golden
// link from the source onto the survivor, mark the source status='merged'
// with merged_into_id pointing at the survivor, write the source's name
// as a kind='rename' alias on the survivor so future matcher runs on
// the old name auto-route to the survivor. No DELETE anywhere; the
// source row stays queryable forever. Confirmed items stay confirmed -
// only their ingredient_id changes - so coverage totals are preserved.
// Fully undoable via undoMergeIngredient, which reads the moved-item
// list from the pr_events row the merge wrote.
// ---------------------------------------------------------------------------

export async function mergeIngredients(
  client: SupabaseClient,
  args: { sourceId: string; targetId: string; actorEmail: string }
): Promise<{ ok: boolean; error?: string; movedItems: number; movedGoldenLinks: number }> {
  const { sourceId, targetId, actorEmail } = args;
  if (sourceId === targetId) {
    return { ok: false, error: "Source and target must differ", movedItems: 0, movedGoldenLinks: 0 };
  }

  const [sourceRes, targetRes] = await Promise.all([
    client.from("pr_ingredients").select("id,name,name_norm,status,merged_into_id").eq("id", sourceId).maybeSingle(),
    client.from("pr_ingredients").select("id,name,name_norm,status").eq("id", targetId).maybeSingle(),
  ]);
  if (sourceRes.error) return { ok: false, error: sourceRes.error.message, movedItems: 0, movedGoldenLinks: 0 };
  if (targetRes.error) return { ok: false, error: targetRes.error.message, movedItems: 0, movedGoldenLinks: 0 };
  const source = sourceRes.data as
    | { id: string; name: string; name_norm: string; status: string; merged_into_id: string | null }
    | null;
  const target = targetRes.data as
    | { id: string; name: string; name_norm: string; status: string }
    | null;
  if (!source) return { ok: false, error: "Source ingredient not found", movedItems: 0, movedGoldenLinks: 0 };
  if (!target) return { ok: false, error: "Target ingredient not found", movedItems: 0, movedGoldenLinks: 0 };
  if (source.status === "merged") return { ok: false, error: "Source is already merged", movedItems: 0, movedGoldenLinks: 0 };
  if (target.status === "merged") return { ok: false, error: "Target is itself merged - pick its survivor", movedItems: 0, movedGoldenLinks: 0 };

  // Collect the item ids that will move. We save them in the merge event
  // so the undo path knows exactly which items to send back - we never
  // reclaim items that moved to target by some other path.
  const { data: itemsData, error: itemsErr } = await client
    .from("pr_vendor_items")
    .select("id,link_status")
    .eq("ingredient_id", sourceId);
  if (itemsErr) return { ok: false, error: itemsErr.message, movedItems: 0, movedGoldenLinks: 0 };
  const items = (itemsData ?? []) as Array<{ id: string; link_status: string }>;
  const itemIds = items.map((i) => i.id);

  // Move items. Only match on current source so a race doesn't move a
  // row that was re-assigned since we read it.
  let movedItems = 0;
  if (itemIds.length > 0) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({ ingredient_id: targetId })
      .in("id", itemIds)
      .eq("ingredient_id", sourceId);
    if (error) return { ok: false, error: error.message, movedItems: 0, movedGoldenLinks: 0 };
    movedItems = itemIds.length;
  }

  // Move active golden links.
  let movedGoldenLinks = 0;
  const { data: glData } = await client
    .from("pr_golden_links")
    .select("id,vendor_item_id")
    .eq("ingredient_id", sourceId)
    .is("revoked_at", null);
  const golden = (glData ?? []) as Array<{ id: string; vendor_item_id: string }>;
  if (golden.length > 0) {
    const { error } = await client
      .from("pr_golden_links")
      .update({ ingredient_id: targetId })
      .eq("ingredient_id", sourceId)
      .is("revoked_at", null);
    if (error) return { ok: false, error: error.message, movedItems, movedGoldenLinks: 0 };
    movedGoldenLinks = golden.length;
  }

  // Flip source to merged. updated_at is auto-maintained by trigger.
  const { error: srcErr } = await client
    .from("pr_ingredients")
    .update({ status: "merged", merged_into_id: targetId, updated_at: new Date().toISOString() })
    .eq("id", sourceId);
  if (srcErr) return { ok: false, error: srcErr.message, movedItems, movedGoldenLinks };

  // Source name becomes a rename-alias on the survivor so the matcher
  // can auto-link on the old name on a future intake. Plain upsert on
  // the schema's unique (alias_norm, kind) - latest claim wins. The
  // revoked_at:null in the payload clears a prior rename-revoke if the
  // same alias was previously revoked.
  const { error: aliasErr } = await client
    .from("pr_ingredient_aliases")
    .upsert(
      {
        ingredient_id: targetId,
        alias_text: source.name,
        alias_norm: source.name_norm,
        kind: "rename",
        revoked_at: null,
      },
      { onConflict: "alias_norm,kind" }
    );
  if (aliasErr) {
    // Non-fatal; the merge already landed. Log the detail in pr_events
    // so we see the alias didn't take.
    // eslint-disable-next-line no-console
    console.error(`merge alias upsert failed: ${aliasErr.message}`);
  }

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: sourceId,
    kind: "ingredient_merged",
    before: {
      source_id: sourceId,
      source_name: source.name,
      source_norm: source.name_norm,
      item_ids: itemIds,
      golden_link_ids: golden.map((g) => g.id),
    },
    after: {
      target_id: targetId,
      target_name: target.name,
      moved_items: movedItems,
      moved_golden_links: movedGoldenLinks,
    },
    actor: actorEmail,
  });

  return { ok: true, movedItems, movedGoldenLinks };
}

// Reverse the most recent merge for `sourceId`: move items + active
// golden links back from the survivor, flip source status back to
// 'active' with merged_into_id cleared, soft-revoke the rename alias.
// Reads the moved-item list from the merge's pr_events row so we only
// return items that this merge brought in - not any that joined target
// by some other path.
export async function undoMergeIngredient(
  client: SupabaseClient,
  args: { sourceId: string; actorEmail: string }
): Promise<{ ok: boolean; error?: string; restoredItems: number; restoredGoldenLinks: number }> {
  const { sourceId, actorEmail } = args;

  const { data: srcData, error: srcErr } = await client
    .from("pr_ingredients")
    .select("id,name,name_norm,status,merged_into_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (srcErr) return { ok: false, error: srcErr.message, restoredItems: 0, restoredGoldenLinks: 0 };
  const source = srcData as
    | { id: string; name: string; name_norm: string; status: string; merged_into_id: string | null }
    | null;
  if (!source) return { ok: false, error: "Source ingredient not found", restoredItems: 0, restoredGoldenLinks: 0 };
  if (source.status !== "merged" || !source.merged_into_id) {
    return { ok: false, error: "Ingredient is not merged; nothing to undo", restoredItems: 0, restoredGoldenLinks: 0 };
  }

  // Find the merge event that landed this state. Pick the latest - a
  // merge is terminal, but a re-merge after undo could stack events.
  const { data: evData, error: evErr } = await client
    .from("pr_events")
    .select("id,before,after")
    .eq("entity_type", "ingredient")
    .eq("entity_id", sourceId)
    .eq("kind", "ingredient_merged")
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (evErr) return { ok: false, error: evErr.message, restoredItems: 0, restoredGoldenLinks: 0 };
  const event = evData as
    | { id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
    | null;
  if (!event) return { ok: false, error: "No merge event found for this ingredient", restoredItems: 0, restoredGoldenLinks: 0 };

  const targetId = source.merged_into_id;
  const before = event.before ?? {};
  const rawItemIds = Array.isArray((before as { item_ids?: unknown }).item_ids)
    ? ((before as { item_ids: unknown[] }).item_ids.filter((x) => typeof x === "string") as string[])
    : [];

  // Move items back - only those that are still on target (defensive
  // against items that moved elsewhere after the merge).
  let restoredItems = 0;
  if (rawItemIds.length > 0) {
    const { error } = await client
      .from("pr_vendor_items")
      .update({ ingredient_id: sourceId })
      .in("id", rawItemIds)
      .eq("ingredient_id", targetId);
    if (error) return { ok: false, error: error.message, restoredItems: 0, restoredGoldenLinks: 0 };
    restoredItems = rawItemIds.length;
  }

  // Move active golden links back by vendor_item_id (we have the list).
  let restoredGoldenLinks = 0;
  if (rawItemIds.length > 0) {
    const { data: gl } = await client
      .from("pr_golden_links")
      .select("id")
      .in("vendor_item_id", rawItemIds)
      .eq("ingredient_id", targetId)
      .is("revoked_at", null);
    const toMove = (gl ?? []) as Array<{ id: string }>;
    if (toMove.length > 0) {
      const { error } = await client
        .from("pr_golden_links")
        .update({ ingredient_id: sourceId })
        .in("vendor_item_id", rawItemIds)
        .eq("ingredient_id", targetId)
        .is("revoked_at", null);
      if (error) return { ok: false, error: error.message, restoredItems, restoredGoldenLinks: 0 };
      restoredGoldenLinks = toMove.length;
    }
  }

  // Flip source back to active.
  const { error: upErr } = await client
    .from("pr_ingredients")
    .update({ status: "active", merged_into_id: null, updated_at: new Date().toISOString() })
    .eq("id", sourceId);
  if (upErr) return { ok: false, error: upErr.message, restoredItems, restoredGoldenLinks };

  // Soft-revoke the rename alias (never DELETE).
  const nowIso = new Date().toISOString();
  const { error: aliasErr } = await client
    .from("pr_ingredient_aliases")
    .update({ revoked_at: nowIso })
    .eq("alias_norm", source.name_norm)
    .eq("kind", "rename")
    .eq("ingredient_id", targetId)
    .is("revoked_at", null);
  if (aliasErr) {
    // Non-fatal.
    // eslint-disable-next-line no-console
    console.error(`undo merge alias revoke failed: ${aliasErr.message}`);
  }

  await client.from("pr_events").insert({
    entity_type: "ingredient",
    entity_id: sourceId,
    kind: "ingredient_merge_undo",
    before: { target_id: targetId },
    after: { restored_items: restoredItems, restored_golden_links: restoredGoldenLinks },
    actor: actorEmail,
  });

  return { ok: true, restoredItems, restoredGoldenLinks };
}
