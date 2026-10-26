// AI matcher. Reads unlinked food vendor items (dollar-ordered), LEFT JOINs
// pr_vendor_catalog for a clean name + category, batches 35 at a time to
// Claude with the 147 active ingredients as the only legal ingredient_ids,
// validates every returned id, and writes link_status='proposed' with the
// model's reason prefixed `ai:` (or `ai-new:` / `ai-notfood:`).
//
// Hard constraints:
//   - Proposed only - never golden, never a flip to 'confirmed'.
//   - Never overwrites a row the human already touched (confirmed/rejected).
//   - Idempotent - a second run only touches still-unlinked items.
//   - pr_ writes only. Reads pr_vendor_items + pr_vendor_catalog +
//     pr_ingredients; writes pr_vendor_items + pr_events.
//   - Paginated reads at 1000 (PostgREST cap).

import { SupabaseClient } from "@supabase/supabase-js";
import { callAnthropicJson } from "./anthropic";

export type MatcherMode = "full" | "slice";

export type MatcherOptions = {
  mode?: MatcherMode;
  limit?: number;        // slice mode: process up to this many items
  batchSize?: number;    // model batch; default 35
  logger?: (msg: string) => void;
};

type IngredientRow = { id: string; name: string; parent: string | null };

type ItemForMatch = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  pack_text: string | null;
  usd_12m: number | null;
};

type CatalogRow = {
  vendor_id: string;
  item_number_norm: string | null;
  clean_name: string | null;
  category: string | null;
};

type ModelDecision =
  | { ref: string; kind: "existing"; ingredient_id: string; confidence: "high" | "med" | "low"; reason: string }
  | { ref: string; kind: "new"; proposed_name: string; proposed_parent?: string | null; confidence: "high" | "med" | "low"; reason: string }
  | { ref: string; kind: "not_food"; confidence: "high" | "med" | "low"; reason: string };

type RunCounts = {
  items_read: number;
  items_sent: number;
  decisions_received: number;
  invalid_ids_dropped: number;
  proposed_existing: number;
  proposed_new: number;
  marked_not_food: number;
  write_errors: number;
  batches_ok: number;
  batches_failed: number;
  input_tokens: number;
  output_tokens: number;
  model: string;
};

const SYSTEM_PROMPT = `You are a careful food-category matcher. For each item, choose ONE of:

  (a) an existing ingredient from the provided list (by ingredient_id); or
  (b) new, if no existing ingredient fits (give a short proposed name and a parent); or
  (c) not_food, if the item is clearly not a food ingredient.

Rules:
- Use the item's vendor category as a strong prior. A "Meat" category item is a meat; "Beverage" is not produce.
- Prefer an existing ingredient over new unless clearly absent from the list.
- Confidence levels: high = unambiguous; med = reasonable but could be reclassified by a human; low = ambiguous.
- Keep "reason" to one short sentence.
- Return ONLY a JSON object with the shape { "decisions": [ ... ] }. No prose, no markdown fences.

Each decision object:
  { "ref": "<item ref>", "kind": "existing"|"new"|"not_food", "confidence": "high"|"med"|"low", "reason": "<one line>",
    // kind=existing adds: "ingredient_id": "<uuid>"
    // kind=new adds: "proposed_name": "<short name>", "proposed_parent": "<parent or null>"
  }`;

function userPrompt(ingredients: IngredientRow[], batch: Array<{ ref: string; name: string; category: string | null; pack: string | null }>): string {
  const ingList = ingredients
    .map((i) => `  { id: "${i.id}", name: ${JSON.stringify(i.name)}, parent: ${i.parent ? JSON.stringify(i.parent) : "null"} }`)
    .join(",\n");
  const itemList = batch
    .map((b) =>
      `  { ref: "${b.ref}", name: ${JSON.stringify(b.name)}, category: ${
        b.category ? JSON.stringify(b.category) : "null"
      }, pack: ${b.pack ? JSON.stringify(b.pack) : "null"} }`
    )
    .join(",\n");
  return `Ingredients (choose by id):
[
${ingList}
]

Items (one decision per ref):
[
${itemList}
]`;
}

async function readAllIngredients(client: SupabaseClient): Promise<IngredientRow[]> {
  const out: IngredientRow[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await client
      .from("pr_ingredients")
      .select("id,name,parent")
      .eq("status", "active")
      .order("name", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    const chunk = (data ?? []) as IngredientRow[];
    out.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }
  return out;
}

async function readUnlinkedItems(
  client: SupabaseClient,
  limit: number | undefined,
  log: (m: string) => void
): Promise<ItemForMatch[]> {
  const out: ItemForMatch[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const q = client
      .from("pr_vendor_items")
      .select(
        "id,vendor_id,item_number,item_number_norm,name,pack_text,usd_12m",
        { count: "exact" }
      )
      .eq("is_food", true)
      .in("status", ["active", "resale"])
      .in("link_status", ["none"])
      .order("usd_12m", { ascending: false, nullsFirst: false });
    const to = from + page - 1;
    const { data, error } = await q.range(from, to);
    if (error) throw error;
    const chunk = (data ?? []) as ItemForMatch[];
    out.push(...chunk);
    log(`  read ${out.length} unlinked food items...`);
    if (chunk.length < page) break;
    from += page;
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

async function readCatalogFor(
  client: SupabaseClient,
  items: ItemForMatch[]
): Promise<Map<string, CatalogRow>> {
  // Key by `${vendor_id}#${item_number_norm}`. Catalog only matches items that
  // carry an item_number_norm; items without a number stay catalog-less and
  // the matcher falls back to the invoice name + no category.
  const keys = new Set<string>();
  const byVendor = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.item_number_norm) continue;
    const vset = byVendor.get(it.vendor_id) ?? new Set<string>();
    vset.add(it.item_number_norm);
    byVendor.set(it.vendor_id, vset);
    keys.add(`${it.vendor_id}#${it.item_number_norm}`);
  }
  const out = new Map<string, CatalogRow>();
  for (const [vendorId, nums] of byVendor) {
    const page = 500;
    const list = Array.from(nums);
    for (let i = 0; i < list.length; i += page) {
      const slice = list.slice(i, i + page);
      const { data, error } = await client
        .from("pr_vendor_catalog")
        .select("vendor_id,item_number_norm,clean_name,category")
        .eq("vendor_id", vendorId)
        .in("item_number_norm", slice);
      if (error) throw error;
      for (const r of (data ?? []) as CatalogRow[]) {
        if (!r.item_number_norm) continue;
        out.set(`${r.vendor_id}#${r.item_number_norm}`, r);
      }
    }
  }
  return out;
}

function pickName(invoiceName: string, cat: CatalogRow | undefined): string {
  const clean = cat?.clean_name?.trim();
  return clean && clean.length > 0 ? clean : invoiceName;
}

function confidenceToNumber(c: "high" | "med" | "low"): number {
  if (c === "high") return 0.9;
  if (c === "med") return 0.6;
  return 0.3;
}

async function writeDecisions(
  client: SupabaseClient,
  decisions: Array<{ item: ItemForMatch; decision: ModelDecision }>,
  ingredientIdSet: Set<string>,
  counts: RunCounts,
  log: (m: string) => void
) {
  for (const { item, decision } of decisions) {
    // Re-read link_status just before write so a confirm that landed mid-run
    // never gets stomped. Cheap single-row lookup.
    const { data: cur } = await client
      .from("pr_vendor_items")
      .select("link_status")
      .eq("id", item.id)
      .maybeSingle();
    const curStatus = (cur as { link_status?: string } | null)?.link_status ?? "none";
    if (curStatus !== "none") continue; // human-touched; skip.

    if (decision.kind === "existing") {
      if (!ingredientIdSet.has(decision.ingredient_id)) {
        counts.invalid_ids_dropped += 1;
        continue;
      }
      const { error } = await client
        .from("pr_vendor_items")
        .update({
          ingredient_id: decision.ingredient_id,
          link_status: "proposed",
          link_confidence: decision.confidence,
          link_reason: `ai:${decision.reason}`,
        })
        .eq("id", item.id)
        .eq("link_status", "none");
      if (error) {
        counts.write_errors += 1;
        log(`  write error on ${item.id}: ${error.message}`);
      } else {
        counts.proposed_existing += 1;
      }
    } else if (decision.kind === "new") {
      const payload = {
        proposed_name: decision.proposed_name,
        proposed_parent: decision.proposed_parent ?? null,
        reason: decision.reason,
      };
      const { error } = await client
        .from("pr_vendor_items")
        .update({
          link_status: "proposed",
          link_confidence: decision.confidence,
          link_reason: `ai-new:${JSON.stringify(payload)}`,
        })
        .eq("id", item.id)
        .eq("link_status", "none");
      if (error) {
        counts.write_errors += 1;
      } else {
        counts.proposed_new += 1;
      }
    } else {
      // not_food - don't flip is_food (that's intake's job). Just surface
      // the model's view via link_reason so the queue can show it.
      const { error } = await client
        .from("pr_vendor_items")
        .update({ link_reason: `ai-notfood:${decision.reason}` })
        .eq("id", item.id)
        .eq("link_status", "none");
      if (error) {
        counts.write_errors += 1;
      } else {
        counts.marked_not_food += 1;
      }
    }
  }
}

export async function runMatcher(
  client: SupabaseClient,
  options: MatcherOptions = {}
): Promise<{ status: "ok" | "failed"; counts: RunCounts; note: string | null; runId: string | null }> {
  const log = options.logger ?? (() => {});
  const batchSize = Math.max(5, Math.min(60, options.batchSize ?? 35));

  const counts: RunCounts = {
    items_read: 0,
    items_sent: 0,
    decisions_received: 0,
    invalid_ids_dropped: 0,
    proposed_existing: 0,
    proposed_new: 0,
    marked_not_food: 0,
    write_errors: 0,
    batches_ok: 0,
    batches_failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: "",
  };
  let runId: string | null = null;
  let note: string | null = null;

  // Open a run row so partial progress is auditable.
  const { data: runIns, error: runErr } = await client
    .from("pr_events")
    .insert({
      entity_type: "matcher",
      entity_id: "00000000-0000-0000-0000-000000000000",
      kind: "ai_match_run_started",
      after: { mode: options.mode ?? "full", limit: options.limit ?? null, batchSize },
      actor: "matcher",
    })
    .select("id")
    .single();
  if (!runErr) runId = (runIns as { id: string } | null)?.id ?? null;

  try {
    log("Reading 147 active ingredients...");
    const ingredients = await readAllIngredients(client);
    const ingredientIdSet = new Set(ingredients.map((i) => i.id));
    log(`Loaded ${ingredients.length} ingredients.`);

    log("Reading unlinked food items (dollar-ordered)...");
    const items = await readUnlinkedItems(client, options.limit, log);
    counts.items_read = items.length;
    log(`Read ${items.length} items.`);

    log("Reading matching catalog rows...");
    const catalog = await readCatalogFor(client, items);
    log(`Catalog matched ${catalog.size} of ${items.length}.`);

    for (let i = 0; i < items.length; i += batchSize) {
      const slice = items.slice(i, i + batchSize);
      const batchRefs = slice.map((it) => {
        const cat = it.item_number_norm ? catalog.get(`${it.vendor_id}#${it.item_number_norm}`) : undefined;
        return {
          ref: it.id,
          name: pickName(it.name, cat),
          category: cat?.category ?? null,
          pack: it.pack_text,
        };
      });

      counts.items_sent += slice.length;
      log(`Batch ${Math.floor(i / batchSize) + 1} (${slice.length} items)...`);

      try {
        const result = await callAnthropicJson<{ decisions: ModelDecision[] }>({
          system: SYSTEM_PROMPT,
          user: userPrompt(ingredients, batchRefs),
          // ~90 output tokens per item of JSON; size to the batch with headroom
          // so a full batch is never truncated (batchSize is capped at 60).
          maxTokens: Math.min(16384, 512 + slice.length * 160),
          temperature: 0,
        });
        counts.input_tokens += result.usage.input_tokens;
        counts.output_tokens += result.usage.output_tokens;
        counts.model = result.model;
        const decisions = result.parsed?.decisions ?? [];
        counts.decisions_received += decisions.length;

        // Index decisions by ref for the write pass.
        const byRef = new Map<string, ModelDecision>();
        for (const d of decisions) byRef.set(d.ref, d);
        const paired: Array<{ item: ItemForMatch; decision: ModelDecision }> = [];
        for (const it of slice) {
          const d = byRef.get(it.id);
          if (d) paired.push({ item: it, decision: d });
        }
        await writeDecisions(client, paired, ingredientIdSet, counts, log);
        counts.batches_ok += 1;
      } catch (e) {
        counts.batches_failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        log(`  batch failed: ${msg}`);
        if (!note) note = msg; // keep the first error for the ledger
        // Do NOT abort the whole run; move to the next batch so partial
        // progress survives.
      }
    }

    // Close the run row.
    await client.from("pr_events").insert({
      entity_type: "matcher",
      entity_id: "00000000-0000-0000-0000-000000000000",
      kind: "ai_match_run",
      after: { counts, note },
      actor: "matcher",
      note,
    });

    log("Matcher done.");
    return { status: "ok", counts, note, runId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await client.from("pr_events").insert({
      entity_type: "matcher",
      entity_id: "00000000-0000-0000-0000-000000000000",
      kind: "ai_match_run",
      after: { counts, note: msg },
      actor: "matcher",
      note: msg,
    });
    log(`Matcher failed: ${msg}`);
    return { status: "failed", counts, note: msg, runId };
  }
}
