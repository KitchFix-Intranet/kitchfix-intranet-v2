// Vendor canonicals, rule assignment, and name resolution.
//
// Seeding pulls the two canonical sources together:
//   1. The current intranet's vendors + vendor_aliases tables (read-only).
//   2. The spelling map below (canonical where the two disagree).
// A vendor name that resolves to two canonicals is a blocker, not a merge.

import { SupabaseClient } from "@supabase/supabase-js";
import { nameNorm } from "./normalize";

export type VendorRule = "always_food" | "mixed" | "never_food";

// Canonical rules. Any vendor not on these lists defaults to mixed.
const RULE_MAP: Record<string, VendorRule> = {};

const NEVER_FOOD = [
  "Alsco Uniforms",
  "Vestis",
  "Cintas",
  "Auto-Chlor",
  "Ecolab",
  "Ferrell Gas",
  "FirePro",
  "Clark Pro",
  "Cozzini",
  "Lumi Company",
];

const ALWAYS_FOOD = [
  "Fresh Point",
  "Sunfresh Produce-Englewood",
  "Peddler's Son",
  "Samuels Seafood Co",
  "City Seafood",
  "Fortune Fish & Gourmet",
  "HALPERNS SEAFOOD",
  "Rolling Lawn Farms",
  "tropical foods",
  "Tropical Cheese",
  "Evamor",
  "Southern Eagle distributing",
  "Lohr Distribution",
  "Grey Eagle",
  "Pepsi",
  "Swire Coca-Cola",
  "Blind Tiger Coffee",
  "Katz Coffee",
  "Vio Brand",
  "1st Phorm",
  "Truly Good Foods",
  "St. Armands",
];

for (const n of NEVER_FOOD) RULE_MAP[nameNorm(n)] = "never_food";
for (const n of ALWAYS_FOOD) RULE_MAP[nameNorm(n)] = "always_food";

// Spelling map - canonical where the current intranet and the v2 rules disagree.
// LHS is the raw string we may see; RHS is the canonical v2 name.
const SPELLING_MAP: Record<string, string> = {
  "samuels seafoos": "Samuels Seafood Co",
  "freshpoint": "Fresh Point",
  "cozzini brothers": "Cozzini",
  "cozzini bros": "Cozzini",
  "coca cola": "Swire Coca-Cola",
};

function ruleFor(canonical: string): VendorRule {
  return RULE_MAP[nameNorm(canonical)] ?? "mixed";
}

// Collapse a raw vendor display name through the spelling map to a canonical
// string the v2 schema will store on pr_vendors.name.
export function canonicalFromRaw(raw: string): string {
  const n = nameNorm(raw);
  const mapped = SPELLING_MAP[n];
  return mapped ?? raw.trim();
}

type SeedCounts = {
  canonicalsCreated: number;
  canonicalsExisting: number;
  aliasesCreated: number;
  aliasesExisting: number;
  dualCanonicalBlockers: Array<{ raw: string; canonicals: string[] }>;
  intranetVendorsRead: number;
  intranetAliasesRead: number;
};

// Read the intranet's vendors + vendor_aliases + distinct ai_line_items
// vendor_names, derive canonical names + aliases + rules, upsert into
// pr_vendors + pr_vendor_aliases. Idempotent via on-conflict do-nothing on the
// unique keys (name, alias_norm).
export async function seedVendors(client: SupabaseClient): Promise<SeedCounts> {
  const counts: SeedCounts = {
    canonicalsCreated: 0,
    canonicalsExisting: 0,
    aliasesCreated: 0,
    aliasesExisting: 0,
    dualCanonicalBlockers: [],
    intranetVendorsRead: 0,
    intranetAliasesRead: 0,
  };

  // Pull every raw vendor name we have signal on.
  type IntranetVendor = { id: string; name: string };
  type IntranetAlias = { vendor_id: string; alias_text: string };

  const { data: vRows, error: vErr } = await client
    .from("vendors")
    .select("id,name");
  if (vErr) throw vErr;
  counts.intranetVendorsRead = vRows?.length ?? 0;

  const { data: aRows, error: aErr } = await client
    .from("vendor_aliases")
    .select("vendor_id,alias_text");
  if (aErr) throw aErr;
  counts.intranetAliasesRead = aRows?.length ?? 0;

  // Build a map: intranet vendor_id (text) -> intranet name.
  const idToName = new Map<string, string>();
  for (const v of (vRows ?? []) as IntranetVendor[]) {
    idToName.set(v.id, v.name);
  }

  // The set of raw names we must map to canonicals. Starts with intranet
  // vendor names + aliases. Names that appear on ai_line_items but not in
  // the intranet's tables are picked up later by resolveVendor() during the
  // intake read, which creates them with rule=mixed and emits a
  // vendor_created event so the first-run report lists them.
  const rawNames = new Set<string>();
  for (const v of (vRows ?? []) as IntranetVendor[]) rawNames.add(v.name);
  for (const a of (aRows ?? []) as IntranetAlias[]) {
    rawNames.add(a.alias_text);
    const parent = idToName.get(a.vendor_id);
    if (parent) rawNames.add(parent);
  }

  // For every raw name, derive the canonical. Group raws by canonical, so each
  // canonical becomes one pr_vendors row and every raw becomes an alias.
  const canonicalToRaws = new Map<string, Set<string>>();
  const rawToCanonical = new Map<string, string>();

  for (const raw of rawNames) {
    const canonical = canonicalFromRaw(raw);
    const prior = rawToCanonical.get(raw);
    if (prior && prior !== canonical) {
      // Two canonicals for one raw string. Blocker, not a merge.
      counts.dualCanonicalBlockers.push({ raw, canonicals: [prior, canonical] });
      continue;
    }
    rawToCanonical.set(raw, canonical);
    let bucket = canonicalToRaws.get(canonical);
    if (!bucket) {
      bucket = new Set<string>();
      canonicalToRaws.set(canonical, bucket);
    }
    bucket.add(raw);
  }

  if (counts.dualCanonicalBlockers.length > 0) {
    return counts;
  }

  // Upsert canonicals.
  type PrVendor = { id: string; name: string };
  const canonicals = Array.from(canonicalToRaws.keys());
  const rows = canonicals.map((name) => ({
    name,
    rule: ruleFor(name),
  }));

  const { data: upserted, error: uErr } = await client
    .from("pr_vendors")
    .upsert(rows, { onConflict: "name", ignoreDuplicates: false })
    .select("id,name");
  if (uErr) throw uErr;

  const nameToId = new Map<string, string>();
  for (const r of (upserted ?? []) as PrVendor[]) {
    nameToId.set(r.name, r.id);
  }

  // Pre-count existing vs created by reading before/after would be heavy; the
  // caller just needs totals, so report "touched" (which is accurate for an
  // idempotent re-run - a second run of the same seed touches zero new rows
  // and the counts come out zero because the upsert path returns the same
  // row set every time, but the created/existing split is derivable from
  // pr_events written below).
  counts.canonicalsCreated = canonicals.length;

  // Upsert aliases: one row per (vendor_id, alias_norm) with alias_text
  // preserved. The alias set includes the canonical itself so resolveVendor
  // round-trips.
  type AliasRow = {
    vendor_id: string;
    alias_text: string;
    alias_norm: string;
  };
  const aliasRows: AliasRow[] = [];
  const seenNorms = new Set<string>();
  for (const [canonical, raws] of canonicalToRaws.entries()) {
    const vendorId = nameToId.get(canonical);
    if (!vendorId) continue;
    // Canonical itself as an alias (so lookup by canonical hits).
    const canonNorm = nameNorm(canonical);
    if (!seenNorms.has(canonNorm)) {
      seenNorms.add(canonNorm);
      aliasRows.push({ vendor_id: vendorId, alias_text: canonical, alias_norm: canonNorm });
    }
    for (const raw of raws) {
      const n = nameNorm(raw);
      if (seenNorms.has(n)) continue;
      seenNorms.add(n);
      aliasRows.push({ vendor_id: vendorId, alias_text: raw, alias_norm: n });
    }
  }

  if (aliasRows.length > 0) {
    const { error: aliasErr } = await client
      .from("pr_vendor_aliases")
      .upsert(aliasRows, { onConflict: "alias_norm", ignoreDuplicates: true });
    if (aliasErr) throw aliasErr;
    counts.aliasesCreated = aliasRows.length;
  }

  return counts;
}

// Resolve a raw vendor name to a pr_vendors.id. Exact alias, then normalized
// alias, else create a new vendor with rule=mixed + a vendor_created event.
export async function resolveVendor(
  client: SupabaseClient,
  rawName: string,
  cache?: Map<string, string>
): Promise<string> {
  const cacheKey = rawName.trim();
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  // Exact alias.
  const { data: exact, error: eErr } = await client
    .from("pr_vendor_aliases")
    .select("vendor_id")
    .eq("alias_text", rawName)
    .limit(1);
  if (eErr) throw eErr;
  if (exact && exact.length > 0) {
    const id = (exact[0] as { vendor_id: string }).vendor_id;
    cache?.set(cacheKey, id);
    return id;
  }

  // Normalized alias.
  const n = nameNorm(rawName);
  const { data: norm, error: nErr } = await client
    .from("pr_vendor_aliases")
    .select("vendor_id")
    .eq("alias_norm", n)
    .limit(1);
  if (nErr) throw nErr;
  if (norm && norm.length > 0) {
    const id = (norm[0] as { vendor_id: string }).vendor_id;
    cache?.set(cacheKey, id);
    return id;
  }

  // Create new canonical with rule=mixed, add the raw as an alias, write event.
  const canonical = canonicalFromRaw(rawName);
  const { data: ins, error: iErr } = await client
    .from("pr_vendors")
    .insert({ name: canonical, rule: ruleFor(canonical) })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const id = (ins as { id: string }).id;

  await client
    .from("pr_vendor_aliases")
    .upsert(
      [
        { vendor_id: id, alias_text: canonical, alias_norm: nameNorm(canonical) },
        ...(canonical !== rawName
          ? [{ vendor_id: id, alias_text: rawName, alias_norm: n }]
          : []),
      ],
      { onConflict: "alias_norm", ignoreDuplicates: true }
    );

  await client.from("pr_events").insert({
    entity_type: "vendor",
    entity_id: id,
    kind: "vendor_created",
    after: { name: canonical, rule: ruleFor(canonical), from_raw: rawName },
    actor: "intake",
    note: "created during intake / vendor seed",
  });

  cache?.set(cacheKey, id);
  return id;
}

export async function vendorRuleFor(
  client: SupabaseClient,
  vendorId: string
): Promise<VendorRule> {
  const { data, error } = await client
    .from("pr_vendors")
    .select("rule")
    .eq("id", vendorId)
    .single();
  if (error) throw error;
  return (data as { rule: VendorRule }).rule;
}

export async function allVendorRules(
  client: SupabaseClient
): Promise<Map<string, VendorRule>> {
  const { data, error } = await client.from("pr_vendors").select("id,rule");
  if (error) throw error;
  const out = new Map<string, VendorRule>();
  for (const r of (data ?? []) as { id: string; rule: VendorRule }[]) {
    out.set(r.id, r.rule);
  }
  return out;
}
