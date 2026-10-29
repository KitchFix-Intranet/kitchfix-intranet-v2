// The intake job. Reads pr_v_invoice_lines in pages, groups lines into vendor
// items keyed by (vendor_id, item_number_norm) or (vendor_id, description_key),
// writes aggregates to pr_vendor_items, writes a pr_price_observations row for
// every line (including excluded), writes pr_vendor_item_aliases for every
// distinct description variant, flags duplicate twins, and bookends the whole
// thing with a pr_intake_runs row.
//
// Idempotent: a second run creates one more pr_intake_runs row and leaves
// every other row count untouched. Observations upsert on line_id; vendor
// items upsert on their partial uniques; aliases upsert on their composite
// unique.
//
// Scope for step 1: NO pack parsing, NO ingredient proposals, NO price
// estimates. pack_state stays 'none' on new rows.
//
// Column ownership (data-integrity rule - see docs/GOTCHAS.md):
//   Intake owns the "observed" fields only (identity + rollups).
//   The curation fields - link_status, ingredient_id, link_reason,
//   link_confidence - belong to the matcher + humans. Intake MUST NOT
//   include them in the pr_vendor_items upsert payload: PostgREST
//   overwrites every column present in the body on an existing row
//   (ON CONFLICT DO UPDATE), and that wipes the proposal queue AND
//   human-confirmed links on every run. A new row still lands at
//   link_status='none' via the column DEFAULT.

import { SupabaseClient } from "@supabase/supabase-js";
import { descriptionKey, descriptionNorm, itemNumberNorm } from "./normalize";
import { classifyLine } from "./foodFilter";
import { allVendorRules, resolveVendor, seedVendors, VendorRule } from "./vendors";

export type IntakeMode = "full" | "incremental";

type Line = {
  id: string;
  account_key: string;
  vendor_name: string;
  invoice_date: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  extended_price: number | null;
  category: string | null;
  item_number: string | null;
  pack_size: string | null;
  weight_line_value: number | null;
  catch_weight_marker: string | null;
  needs_review: boolean;
};

type VendorItemAgg = {
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  description_key: string;
  nameCounts: Map<string, number>;
  packCounts: Map<string, number>;
  unitCounts: Map<string, number>;
  descCounts: Map<string, { count: number; display: string; last_seen: string | null }>;
  catch_weight: boolean;
  is_food: boolean | null;
  food_reason: string | null;
  lines: number;
  lines_12m: number;
  usd: number;
  usd_12m: number;
  accounts: Set<string>;
  first_seen: string | null;
  last_seen: string | null;
  needs_review_lines: number;
  lineRows: {
    line_id: string;
    account_key: string;
    invoice_date: string | null;
    unit_price: number | null;
    quantity: number | null;
    extended_price: number | null;
    billed_unit: string | null;
    pack_text: string | null;
    needs_review: boolean;
    catch_weight: boolean;
    weight_line_value: number | null;
    excluded_reason: string | null;
  }[];
};

type IntakeCounts = {
  lines_read: number;
  lines_excluded_not_food: number;
  lines_excluded_needs_review: number;
  vendor_items_touched: number;
  vendor_items_with_number: number;
  vendor_items_without_number: number;
  aliases_written: number;
  observations_written: number;
  twins_found: number;
  vendors_before_seed: number;
  vendors_after_seed: number;
  vendors_after_resolve: number;
  vendors_seed_blockers: Array<{ raw: string; canonicals: string[] }>;
};

function mostFrequent<K>(counts: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function keyFor(vendorId: string, inumNorm: string | null, dkey: string): string {
  return inumNorm != null ? `${vendorId}#N#${inumNorm}` : `${vendorId}#D#${dkey}`;
}

async function pagedLines(
  client: SupabaseClient,
  pageSize: number,
  logger: (msg: string) => void
): Promise<Line[]> {
  const all: Line[] = [];
  const endDate = "2026-12-31";
  const startDate = "2024-01-01";
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await client
      .from("pr_v_invoice_lines")
      .select(
        "id,account_key,vendor_name,invoice_date,description,quantity,unit,unit_price,extended_price,category,item_number,pack_size,weight_line_value,catch_weight_marker,needs_review"
      )
      .gte("invoice_date", startDate)
      .lte("invoice_date", endDate)
      .not("description", "is", null)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    const chunk = (data ?? []) as Line[];
    all.push(...chunk);
    if (chunk.length === 0) break;
    from += chunk.length;
    logger(`  read ${all.length} lines...`);
  }
  return all;
}

async function batchUpsert<T extends object>(
  client: SupabaseClient,
  table: string,
  rows: T[],
  options: { onConflict?: string; ignoreDuplicates?: boolean; batchSize?: number }
): Promise<void> {
  const size = options.batchSize ?? 500;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const { error } = await client
      .from(table)
      .upsert(slice, {
        onConflict: options.onConflict,
        ignoreDuplicates: options.ignoreDuplicates ?? false,
      });
    if (error) {
      throw new Error(`${table} upsert batch @ ${i}/${rows.length}: ${error.message}`);
    }
  }
}

export async function runIntake(
  client: SupabaseClient,
  mode: IntakeMode = "full",
  logger: (msg: string) => void = () => {}
): Promise<{ runId: string; status: "ok" | "failed"; counts: IntakeCounts; note: string | null }> {
  const { data: runIns, error: runErr } = await client
    .from("pr_intake_runs")
    .insert({ started_at: new Date().toISOString(), status: "running", mode })
    .select("id")
    .single();
  if (runErr) throw runErr;
  const runId = (runIns as { id: string }).id;

  const counts: IntakeCounts = {
    lines_read: 0,
    lines_excluded_not_food: 0,
    lines_excluded_needs_review: 0,
    vendor_items_touched: 0,
    vendor_items_with_number: 0,
    vendor_items_without_number: 0,
    aliases_written: 0,
    observations_written: 0,
    twins_found: 0,
    vendors_before_seed: 0,
    vendors_after_seed: 0,
    vendors_after_resolve: 0,
    vendors_seed_blockers: [],
  };

  try {
    const { count: beforeCount } = await client
      .from("pr_vendors")
      .select("id", { count: "exact", head: true });
    counts.vendors_before_seed = beforeCount ?? 0;

    const seedCounts = await seedVendors(client);
    if (seedCounts.dualCanonicalBlockers.length > 0) {
      counts.vendors_seed_blockers = seedCounts.dualCanonicalBlockers;
      throw new Error(
        `Vendor seed blocked by dual canonicals: ${JSON.stringify(seedCounts.dualCanonicalBlockers)}`
      );
    }

    const { count: afterSeedCount } = await client
      .from("pr_vendors")
      .select("id", { count: "exact", head: true });
    counts.vendors_after_seed = afterSeedCount ?? 0;

    const rules = await allVendorRules(client);
    const vendorIdByName = new Map<string, string>();

    logger("Reading pr_v_invoice_lines...");
    const lines = await pagedLines(client, 1000, logger);
    counts.lines_read = lines.length;
    logger(`Read ${lines.length} lines total.`);

    const distinctNames = new Set<string>();
    for (const l of lines) distinctNames.add(l.vendor_name);
    logger(`Resolving ${distinctNames.size} distinct vendor_name values...`);
    for (const name of distinctNames) {
      await resolveVendor(client, name, vendorIdByName);
    }

    const { count: afterResolveCount } = await client
      .from("pr_vendors")
      .select("id", { count: "exact", head: true });
    counts.vendors_after_resolve = afterResolveCount ?? 0;

    const refreshedRules = await allVendorRules(client);
    for (const [k, v] of refreshedRules) rules.set(k, v);

    const today = new Date();
    const cutoff12m = new Date(today);
    cutoff12m.setDate(cutoff12m.getDate() - 365);
    const cutoff12mStr = cutoff12m.toISOString().slice(0, 10);

    logger("Grouping into vendor items...");
    const items = new Map<string, VendorItemAgg>();

    for (const line of lines) {
      const vendorId = vendorIdByName.get(line.vendor_name);
      if (!vendorId) throw new Error(`vendor cache miss for ${line.vendor_name}`);
      const inumNorm = itemNumberNorm(line.item_number);
      const dkey = descriptionKey(line.description);
      const k = keyFor(vendorId, inumNorm, dkey);

      const rule: VendorRule = rules.get(vendorId) ?? "mixed";
      const verdict = classifyLine(rule, line.category, line.description);

      let item = items.get(k);
      if (!item) {
        item = {
          vendor_id: vendorId,
          item_number: inumNorm != null ? line.item_number : null,
          item_number_norm: inumNorm,
          description_key: dkey,
          nameCounts: new Map(),
          packCounts: new Map(),
          unitCounts: new Map(),
          descCounts: new Map(),
          catch_weight: false,
          is_food: null,
          food_reason: null,
          lines: 0,
          lines_12m: 0,
          usd: 0,
          usd_12m: 0,
          accounts: new Set(),
          first_seen: null,
          last_seen: null,
          needs_review_lines: 0,
          lineRows: [],
        };
        items.set(k, item);
      }

      item.nameCounts.set(line.description, (item.nameCounts.get(line.description) ?? 0) + 1);
      if (line.pack_size) item.packCounts.set(line.pack_size, (item.packCounts.get(line.pack_size) ?? 0) + 1);
      if (line.unit) item.unitCounts.set(line.unit, (item.unitCounts.get(line.unit) ?? 0) + 1);

      const dnorm = descriptionNorm(line.description);
      const prior = item.descCounts.get(dnorm);
      if (prior) {
        prior.count += 1;
        if (line.invoice_date && (!prior.last_seen || line.invoice_date > prior.last_seen)) {
          prior.last_seen = line.invoice_date;
        }
      } else {
        item.descCounts.set(dnorm, {
          count: 1,
          display: line.description,
          last_seen: line.invoice_date,
        });
      }

      const isCatchWeight =
        !!line.catch_weight_marker || (line.weight_line_value != null && line.weight_line_value !== 0);
      if (isCatchWeight) item.catch_weight = true;

      if (item.is_food === null) {
        item.is_food = verdict.isFood;
        item.food_reason = verdict.reason;
      } else if (!item.is_food && verdict.isFood) {
        item.is_food = true;
        item.food_reason = verdict.reason;
      }

      let excluded_reason: string | null = null;
      if (!verdict.isFood) excluded_reason = "not_food";
      else if (line.needs_review) excluded_reason = "needs_review";

      item.lineRows.push({
        line_id: line.id,
        account_key: line.account_key,
        invoice_date: line.invoice_date,
        unit_price: line.unit_price,
        quantity: line.quantity,
        extended_price: line.extended_price,
        billed_unit: line.unit,
        pack_text: line.pack_size,
        needs_review: line.needs_review,
        catch_weight: isCatchWeight,
        // Actual billed weight for the line - the ground truth for
        // catch-weight pricing. Previously collapsed into the
        // catch_weight boolean and discarded.
        weight_line_value: line.weight_line_value ?? null,
        excluded_reason,
      });

      if (verdict.isFood) {
        item.lines += 1;
        if (line.invoice_date && line.invoice_date >= cutoff12mStr) item.lines_12m += 1;
        const ext = line.extended_price ?? 0;
        item.usd += ext;
        if (line.invoice_date && line.invoice_date >= cutoff12mStr) item.usd_12m += ext;
        item.accounts.add(line.account_key);
        if (line.invoice_date) {
          if (!item.first_seen || line.invoice_date < item.first_seen) item.first_seen = line.invoice_date;
          if (!item.last_seen || line.invoice_date > item.last_seen) item.last_seen = line.invoice_date;
        }
        if (line.needs_review) item.needs_review_lines += 1;
      } else {
        counts.lines_excluded_not_food += 1;
      }
      if (line.needs_review) counts.lines_excluded_needs_review += 1;
    }

    counts.vendor_items_touched = items.size;
    for (const it of items.values()) {
      if (it.item_number_norm != null) counts.vendor_items_with_number += 1;
      else counts.vendor_items_without_number += 1;
    }

    logger(`Grouped ${items.size} vendor items. Writing...`);

    // Intake owns the "observed" columns (identity + rollups) only. The
    // curation columns - link_status, ingredient_id, link_reason,
    // link_confidence - belong to the matcher + humans; intake must NOT
    // write them in this upsert, because PostgREST's ON CONFLICT DO UPDATE
    // overwrites every column present in the body on an existing row, and
    // that would wipe the proposal queue AND human-confirmed links on
    // every run. A brand-new vendor_item still lands at link_status='none'
    // via the column DEFAULT ('none'::text) - already set in 0001; checked
    // against information_schema.columns before this change.
    //
    // See docs/GOTCHAS.md: do not re-add any of the four curation columns
    // to this payload.
    const vItemRows = Array.from(items.values()).map((it) => {
      const pickName = mostFrequent(it.nameCounts) ?? Array.from(it.nameCounts.keys())[0];
      const pickPack = mostFrequent(it.packCounts);
      const pickUnit = mostFrequent(it.unitCounts);
      return {
        vendor_id: it.vendor_id,
        item_number: it.item_number,
        item_number_norm: it.item_number_norm,
        description_key: it.description_key,
        name: pickName ?? "",
        pack_text: pickPack,
        // pack_state intentionally NOT written here. The column defaults to
        // 'none' for new rows; re-writing it on every re-ingest reset
        // human-overridden rows to 'none', and the pack backfill skips any
        // row with a non-null pack_override, so those rows could never be
        // repaired automatically. (Data audit 2026-10-29.)
        billed_unit: pickUnit,
        catch_weight: it.catch_weight,
        is_food: it.is_food ?? false,
        food_reason: it.food_reason,
        first_seen: it.first_seen,
        last_seen: it.last_seen,
        lines: it.lines,
        lines_12m: it.lines_12m,
        usd: it.usd,
        usd_12m: it.usd_12m,
        accounts: Array.from(it.accounts),
        needs_review_lines: it.needs_review_lines,
      };
    });

    await batchUpsert(client, "pr_vendor_items", vItemRows, {
      onConflict: "vendor_id,dedup_key",
    });

    // The upsert above refreshes billed_unit from the modal invoice unit,
    // which would overwrite a value a reviewer set during a pack override.
    // pack_override carries the human's billed_unit, so restore it for
    // those rows only. Small set (tens of rows), one read + targeted writes.
    {
      const { data: ovr, error: ovrErr } = await client
        .from("pr_vendor_items")
        .select("id,billed_unit,pack_override")
        .not("pack_override", "is", null);
      if (ovrErr) throw ovrErr;
      let restored = 0;
      for (const r of (ovr ?? []) as {
        id: string;
        billed_unit: string | null;
        pack_override: { billed_unit?: string | null } | null;
      }[]) {
        const human = r.pack_override?.billed_unit ?? null;
        if (!human || human === r.billed_unit) continue;
        const { error: resErr } = await client
          .from("pr_vendor_items")
          .update({ billed_unit: human })
          .eq("id", r.id);
        if (resErr) throw resErr;
        restored += 1;
      }
      if (restored > 0) logger(`Restored human billed_unit on ${restored} overridden rows`);
    }

    logger("Reading back vendor_item ids...");
    const idByKey = new Map<string, string>();
    {
      const pageSize = 1000;
      let start = 0;
      for (;;) {
        const { data, error } = await client
          .from("pr_vendor_items")
          .select("id,vendor_id,item_number_norm,description_key")
          .order("id", { ascending: true })
          .range(start, start + pageSize - 1);
        if (error) throw error;
        const chunk = (data ?? []) as {
          id: string;
          vendor_id: string;
          item_number_norm: string | null;
          description_key: string;
        }[];
        for (const r of chunk) {
          const k = keyFor(r.vendor_id, r.item_number_norm, r.description_key);
          idByKey.set(k, r.id);
        }
        if (chunk.length < pageSize) break;
        start += pageSize;
      }
    }

    type AliasRow = {
      vendor_item_id: string;
      description: string;
      description_norm: string;
      count: number;
      last_seen: string | null;
    };
    type ObsRow = {
      vendor_item_id: string;
      line_id: string;
      account_key: string;
      invoice_date: string | null;
      unit_price: number | null;
      quantity: number | null;
      extended_price: number | null;
      billed_unit: string | null;
      pack_text: string | null;
      needs_review: boolean;
      catch_weight: boolean;
      weight_line_value: number | null;
      excluded_reason: string | null;
    };

    const aliasRows: AliasRow[] = [];
    const obsRows: ObsRow[] = [];

    for (const [k, it] of items.entries()) {
      const id = idByKey.get(k);
      if (!id) throw new Error(`vendor_item id lookup failed for key ${k}`);
      for (const [dnorm, { count, display, last_seen }] of it.descCounts.entries()) {
        aliasRows.push({
          vendor_item_id: id,
          description: display,
          description_norm: dnorm,
          count,
          last_seen,
        });
      }
      for (const lr of it.lineRows) {
        obsRows.push({ ...lr, vendor_item_id: id });
      }
    }

    counts.aliases_written = aliasRows.length;
    counts.observations_written = obsRows.length;

    await batchUpsert(client, "pr_vendor_item_aliases", aliasRows, {
      onConflict: "vendor_item_id,description_norm",
    });
    await batchUpsert(client, "pr_price_observations", obsRows, {
      onConflict: "line_id",
    });

    logger("Flagging twins...");
    const twinUpdates: { id: string; duplicate_of_id: string }[] = [];
    {
      const haveNumByVendorAndDkey = new Map<string, string>();
      for (const [k, it] of items.entries()) {
        if (it.item_number_norm != null) {
          const dupKey = `${it.vendor_id}#D#${it.description_key}`;
          const parentId = idByKey.get(k);
          if (parentId) haveNumByVendorAndDkey.set(dupKey, parentId);
        }
      }
      for (const [k, it] of items.entries()) {
        if (it.item_number_norm != null) continue;
        const dupKey = `${it.vendor_id}#D#${it.description_key}`;
        const parentId = haveNumByVendorAndDkey.get(dupKey);
        if (parentId) {
          const id = idByKey.get(k);
          if (id && id !== parentId) twinUpdates.push({ id, duplicate_of_id: parentId });
        }
      }
    }
    counts.twins_found = twinUpdates.length;

    for (const u of twinUpdates) {
      // Only update + emit event if the row isn't already flagged.
      const { data: cur, error: curErr } = await client
        .from("pr_vendor_items")
        .select("status,duplicate_of_id")
        .eq("id", u.id)
        .single();
      if (curErr) throw curErr;
      const row = cur as { status: string; duplicate_of_id: string | null };
      if (row.status === "duplicate" && row.duplicate_of_id === u.duplicate_of_id) continue;
      // Never overwrite a deliberate human disposition. Twin detection is a
      // heuristic; a reviewer who archived / retailed / marked an item
      // not-food has already judged it. (Data audit 2026-10-29.)
      if (["archived", "resale", "not_food", "one_off"].includes(row.status)) continue;

      const { error } = await client
        .from("pr_vendor_items")
        .update({ status: "duplicate", duplicate_of_id: u.duplicate_of_id })
        .eq("id", u.id);
      if (error) throw error;
      const { error: eErr } = await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: u.id,
        kind: "vendor_item_twin",
        before: { status: row.status, duplicate_of_id: row.duplicate_of_id },
        after: { status: "duplicate", duplicate_of_id: u.duplicate_of_id },
        actor: "intake",
        note: "intake flagged no-number twin",
      });
      if (eErr) throw eErr;
    }

    const { error: finErr } = await client
      .from("pr_intake_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "ok",
        counts: counts as unknown as Record<string, unknown>,
      })
      .eq("id", runId);
    if (finErr) throw finErr;

    logger("Intake OK.");
    return { runId, status: "ok", counts, note: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await client
      .from("pr_intake_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "failed",
        counts: counts as unknown as Record<string, unknown>,
        note: message,
      })
      .eq("id", runId);
    logger(`Intake failed: ${message}`);
    return { runId, status: "failed", counts, note: message };
  }
}
