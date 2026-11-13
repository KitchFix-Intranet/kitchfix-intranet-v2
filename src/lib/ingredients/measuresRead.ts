// M1: the two-worlds read gate. Amendment 4: which world a request
// serves is decided by the TABLE, never per ingredient. If
// pr_ingredient_measures can be read (no 42P01), the new shape is the
// sole source of truth for every ingredient on this request, and
// pr_vendor_items.case_weight_lb is the only item-level override. Only
// when the table does not exist do we fall back to the old
// each_measure_* columns.
//
// Detected ONCE PER REQUEST, not per row: call `isMeasuresWorld(client)`
// at the top of a handler; it issues a single SELECT and returns a
// boolean. Server-components mount their own copy by calling once and
// passing the flag through.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Measure } from "./measures";

// Supabase JS surfaces the Postgres SQLSTATE as `error.code` on a
// relation-missing error (42P01 = undefined_table). PG REST also sends
// a generic "relation does not exist" string; check both to stay
// resilient if the client version re-shapes the payload.
function isUndefinedTable(err: { code?: string; message?: string | null } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("relation") && m.includes("does not exist");
}

// Does the measures table exist on this database? Single SELECT with
// head:true + limit 1 so no row is transferred. The boolean is enough;
// no row shape, no count.
export async function isMeasuresWorld(client: SupabaseClient): Promise<boolean> {
  const { error } = await client
    .from("pr_ingredient_measures")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (!error) return true;
  if (isUndefinedTable(error)) return false;
  // Any other error (permission, network) - treat as NOT-the-world so the
  // route falls back to legacy columns rather than 500. The error itself
  // is swallowed here; the caller has the data it needs either way.
  return false;
}

// Read the full measures list for one ingredient. Measures-world only.
export async function readMeasuresForIngredient(
  client: SupabaseClient,
  ingredientId: string,
): Promise<Measure[]> {
  const { data, error } = await client
    .from("pr_ingredient_measures")
    .select("from_unit,qty,to_unit,source,from_dim,to_dim")
    .eq("ingredient_id", ingredientId)
    .order("from_dim", { ascending: true })
    .order("to_dim", { ascending: true });
  if (error) return [];
  return (data ?? []).map((r) => ({
    from_unit: String((r as { from_unit: string }).from_unit).toUpperCase(),
    qty: Number((r as { qty: number }).qty),
    to_unit: String((r as { to_unit: string }).to_unit).toUpperCase(),
    source: (r as { source: Measure["source"] }).source,
  }));
}

// Batch read: one query across many ingredient ids. Keyed by
// ingredient_id so callers can look up the subset they need.
export async function readMeasuresFor(
  client: SupabaseClient,
  ingredientIds: readonly string[],
): Promise<Map<string, Measure[]>> {
  const out = new Map<string, Measure[]>();
  if (ingredientIds.length === 0) return out;
  const { data, error } = await client
    .from("pr_ingredient_measures")
    .select("ingredient_id,from_unit,qty,to_unit,source")
    .in("ingredient_id", ingredientIds as string[]);
  if (error) return out;
  for (const row of data ?? []) {
    const r = row as {
      ingredient_id: string;
      from_unit: string;
      qty: number;
      to_unit: string;
      source: Measure["source"];
    };
    const list = out.get(r.ingredient_id) ?? [];
    list.push({
      from_unit: String(r.from_unit).toUpperCase(),
      qty: Number(r.qty),
      to_unit: String(r.to_unit).toUpperCase(),
      source: r.source,
    });
    out.set(r.ingredient_id, list);
  }
  return out;
}

// Legacy-world shim: build a Measure[] from the old each_measure_* columns
// so downstream code sees one shape. One row at most, always count->X.
// Keeps the read layer uniform when the new table is absent.
export function legacyEachMeasureToMeasures(
  qty: number | null,
  uom: string | null,
  source: string | null,
): Measure[] {
  if (qty == null || uom == null) return [];
  if (!Number.isFinite(qty) || qty <= 0) return [];
  const s = (source ?? "estimate").toLowerCase();
  const normalizedSource: Measure["source"] =
    s === "house_test" || s === "book" || s === "vendor_spec" || s === "estimate" || s === "pack"
      ? (s as Measure["source"])
      : "estimate";
  return [
    {
      from_unit: "EA",
      qty: Number(qty),
      to_unit: uom.toUpperCase(),
      source: normalizedSource,
    },
  ];
}
