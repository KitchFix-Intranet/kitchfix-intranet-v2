import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { estimatePerUnit } from "@/lib/ingredients/estimate";
import { DIM_BY_UOM, TO_BASE, normUom, isSlashlessWeightPack, parsePack } from "@/lib/ingredients/pack";
import { bestTrigramMatch } from "@/lib/ingredients/trigram";
import { COUNTABLE_OBSERVATIONS_VIEW } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";
// Q2 §5.2: Vercel serverless timeout. /api/match and /api/intake both
// set 300. This route had no cap and live batches measured 44-53s each,
// so the current ceiling is unknown rather than proven. Setting 300
// explicitly so the cap matches the shape of what the batch takes.
export const maxDuration = 300;

// Cursor-batched backfill of pack_qty / pack_size / pack_uom /
// pack_state / price_estimate on pr_vendor_items for food items in
// active/resale buckets. Each POST processes up to BATCH items from
// `offset`; the client loops until done. Prompt B adds:
//   - actuals aggregation (replaces the latest-only read)
//   - three new price tiers (base-unit short-circuit, catch-weight
//     from actual weight, actuals-case)
//   - pack derivation from Σ weight / Σ quantity (bounded)
//   - dryRun mode: zero writes, returns a diff summary with the top-50
//     largest per-unit changes + would-be flag count
//   - master-level cross-check that writes `flagged` only (never a
//     price or disposition change), capped at 3x deviation, and never
//     overwrites an existing flag
//
// Never writes to a row whose pack_override IS NOT NULL - that's a
// human override we must not clobber. Idempotent: same inputs ->
// same writes.

const BATCH = 400;

// P1 §4.2: trigram-similarity thresholds for catalog-by-name matching.
// Measured on production 2026-11-04: >= 0.75 is a trustworthy visual
// match (e.g. "Beet Ground Brisket Blend" -> "Beef Ground Brisket
// Blend" scores 0.875); 0.55-0.75 is plausible but needs eyes; below
// 0.55 is noise and ignored. A tie at the top is ALSO rejected (per
// §4.2 "ties mean the name is not distinctive enough to be safe").
// pg_trgm is installed on the production DB; the port lives in
// src/lib/ingredients/trigram.ts because Supabase JS cannot return a
// similarity SCORE through PostgREST and P1 forbids migrations.
const NAME_MATCH_MIN = 0.55;
const NAME_MATCH_HIGH = 0.75;
const DERIVED_PACK_MIN_LB = 0.25;
const DERIVED_PACK_MAX_LB = 150;
// Prompt B2: Tier B belt-and-braces. If matched-weight arithmetic
// yields a $/lb outside this band, scrub the weight so the estimator
// falls through to the next catch-weight tier. No real food
// ingredient prices outside this range.
const TIER_B_MIN_PER_LB = 0.05;
const TIER_B_MAX_PER_LB = 200;
const CROSS_CHECK_THRESHOLD = 3; // 3x deviation flags
const CROSS_CHECK_MIN_OTHERS = 2; // need 2+ other priced links on the master

// S3: median-based outlier exclusion. The reference blend used by the
// per-item sanity flag must apply the same rule as IngredientMasters.tsx
// so the two sites agree on what the master's blend IS. Rule: with 3+
// priced peers, any peer >3x median or <median/3 is dropped from the
// reference; otherwise include everything. Constants mirrored in
// IngredientMasters.tsx (OUTLIER_RATIO, OUTLIER_MIN) - identical.
const OUTLIER_RATIO = 3;
const OUTLIER_MIN = 3;

function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Returns the survivor mean for use as the "clean" peer blend. The
// cross-check only needs the headline figure; it does not surface
// which peer was dropped.
function peerSurvivorMean(vs: readonly number[]): number | null {
  if (vs.length === 0) return null;
  if (vs.length < OUTLIER_MIN) {
    const sum = vs.reduce((a, b) => a + b, 0);
    return sum / vs.length;
  }
  const med = medianOf(vs);
  const low = med / OUTLIER_RATIO;
  const high = med * OUTLIER_RATIO;
  const survivors = vs.filter((v) => v >= low && v <= high);
  if (survivors.length === 0) return null;
  const sum = survivors.reduce((a, b) => a + b, 0);
  return sum / survivors.length;
}

type Item = {
  id: string;
  vendor_id: string;
  item_number_norm: string | null;
  name: string;
  pack_text: string | null;
  pack_state: string | null;
  pack_override: unknown;
  catch_weight: boolean;
  ingredient_id: string | null;
  flagged: boolean | null;
  flag_note: string | null;
  price_estimate: Record<string, unknown> | null;
};

type CatalogRow = {
  vendor_id: string;
  item_number_norm: string;
  pack_text: string | null;
  catalog_price: number | null;
};

type NameCatalogRow = {
  clean_name: string | null;
  pack_text: string | null;
  catalog_price: number | null;
};

type Actuals = {
  latest_unit_price: number | null;
  sum_extended: number;
  sum_quantity: number;
  // Prompt E: Σ extended over the lines that ALSO contributed their
  // quantity to sum_quantity - OCR column-copy lines are gated out of
  // both. Tier C must divide spend by quantity over the same line set,
  // or it divides the full spend by a reduced quantity.
  sum_extended_cased: number;
  sum_weight: number;
  // Prompt B1: paired aggregates for Tier A. sum_billed_units is
  // Σ(extended / unit_price) over lines with both > 0;
  // sum_extended_priced is the Σ extended over those SAME lines.
  // Pairing matters - a line with no unit_price contributes to
  // sum_extended but cannot contribute to sum_billed_units; using an
  // unpaired numerator would silently inflate the result.
  sum_billed_units: number;
  sum_extended_priced: number;
  // Prompt B2: paired aggregates for Tier B + pack derivation.
  // sum_weight is only incremented when the line's own arithmetic
  // confirms weight_line_value is a weight (|ext - wt * up| <= 0.05).
  // sum_extended_weight + sum_quantity_weight are the ext / qty totals
  // over those SAME lines so Tier B divides matched spend by matched
  // weight, and pack derivation uses matched weight / matched qty.
  sum_extended_weight: number;
  sum_quantity_weight: number;
  billed_unit: string | null;
  unit_consistent: boolean;
  n_lines: number;
};

type DryRunChange = {
  id: string;
  name: string;
  vendor: string;
  old_per_base: number | null;
  new_per_base: number | null;
  ratio: number; // old/new or new/old, whichever is >=1
  old_source: string | null;
  new_source: string | null;
};

function normalizePackText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toUpperCase().replace(/#/g, "LB").replace(/[^0-9A-Z]/g, "");
}

function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

// Master base_unit -> canonical uom (mirrors IngredientMasters). Shared
// normUom handles LB/EA/GAL/etc.; long-form "POUND(S)" needs the extra
// case.
function canonicalFromBaseUnit(baseUnit: string | null | undefined): string | null {
  if (!baseUnit) return null;
  const u = baseUnit.toUpperCase().trim();
  const n = normUom(u);
  if (n) return n;
  if (u === "POUND" || u === "POUNDS") return "LB";
  return null;
}

// Convert $/A into $/B via the shared factor table. Returns null when A
// and B are from different dimensions (unit mismatch).
function convertPer(value: number, fromUom: string, toUom: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (fromUom === toUom) return value;
  const sf = TO_BASE[fromUom];
  const tf = TO_BASE[toUom];
  if (sf == null || tf == null) return null;
  if (DIM_BY_UOM[fromUom] !== DIM_BY_UOM[toUom]) return null;
  return value * (tf / sf);
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { offset?: number; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // dryRun also accepted as a query param for quick curl probes.
  const url = req.nextUrl;
  const dryRunQ = url.searchParams.get("dryRun");
  const dryRun = body.dryRun === true || dryRunQ === "1" || dryRunQ === "true";
  const offset = Math.max(0, Number(body.offset ?? 0));

  const client = serviceClient();

  // Load one batch of items. Only food, active/resale, override-free.
  // Prompt B: also fetch pack_state + price_estimate (for the dry-run
  // diff) + ingredient_id + flagged/flag_note (for the cross-check).
  const { data: itemsData, error: itemsErr } = await client
    .from("pr_vendor_items")
    .select(
      "id,vendor_id,item_number_norm,name,pack_text,pack_state,pack_override,catch_weight,ingredient_id,flagged,flag_note,price_estimate"
    )
    .eq("is_food", true)
    .in("status", ["active", "resale"])
    .is("pack_override", null)
    .order("id", { ascending: true })
    .range(offset, offset + BATCH - 1);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  const items = (itemsData ?? []) as Item[];

  if (items.length === 0) {
    const emptyCounts = { ok: 0, check: 0, none: 0, skipped: 0, nameMatched: 0, siblingMatched: 0 };
    return NextResponse.json({
      ok: true,
      done: true,
      dryRun,
      processed: 0,
      nextOffset: offset,
      counts: emptyCounts,
      ...(dryRun
        ? {
            dryRunSummary: {
              packStateTransitions: {},
              gainedPerBase: 0,
              lostPerBase: 0,
              bySource: {},
              derivedPacks: { accepted: 0, rejectedByBounds: 0 },
              tierBRejectedByBounds: 0,
              quantityCorrectedToOne: 0,
              wouldBeFlags: 0,
              topChanges: [],
            },
          }
        : {}),
    });
  }

  // Catalog batch: one query per vendor on the ids in this batch.
  const catalogByKey = new Map<string, CatalogRow>();
  {
    const byVendor = new Map<string, Set<string>>();
    for (const it of items) {
      if (!it.item_number_norm) continue;
      let set = byVendor.get(it.vendor_id);
      if (!set) {
        set = new Set();
        byVendor.set(it.vendor_id, set);
      }
      set.add(it.item_number_norm);
    }
    for (const [vendorId, nums] of byVendor) {
      const list = Array.from(nums);
      const page = 500;
      for (let i = 0; i < list.length; i += page) {
        const slice = list.slice(i, i + page);
        const { data: cData, error: cErr } = await client
          .from("pr_vendor_catalog")
          .select("vendor_id,item_number_norm,pack_text,catalog_price")
          .eq("vendor_id", vendorId)
          .in("item_number_norm", slice);
        if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
        for (const r of (cData ?? []) as CatalogRow[]) {
          if (!r.item_number_norm) continue;
          catalogByKey.set(`${r.vendor_id}#${r.item_number_norm}`, r);
        }
      }
    }
  }

  // P1 §4: name-match fallback catalog load.
  //
  // Pre-P1 (Phase 1.9) used strict exact-name equality after
  // normalizeName() - which missed "Beet" vs "Beef", "Filet" vs
  // "Fillet", "TU" vs "TUB". P1 replaces that with trigram similarity
  // (pg_trgm algorithm ported in src/lib/ingredients/trigram.ts
  // because PostgREST does not expose similarity scores and P1 forbids
  // migrations). Tiers: >= 0.75 ok, 0.55-0.75 check, < 0.55 ignore;
  // ties at the top are rejected (name not distinctive).
  //
  // The catalog is loaded once per vendor for every item missing a
  // SKU match - same shape as the Phase 1.9 load, but storing the
  // full row list per vendor rather than a per-name deduped map so
  // the scorer can see every candidate.
  const vendorCatalogRows = new Map<string, Array<NameCatalogRow>>();
  {
    const vendorsNeeding = new Set<string>();
    for (const it of items) {
      if (it.pack_override !== null) continue;
      const skuKey = it.item_number_norm ? `${it.vendor_id}#${it.item_number_norm}` : null;
      if (skuKey && catalogByKey.has(skuKey)) continue;
      vendorsNeeding.add(it.vendor_id);
    }
    for (const vendorId of vendorsNeeding) {
      let from = 0;
      const page = 1000;
      const bucket: Array<NameCatalogRow> = [];
      for (;;) {
        const { data: cData, error: cErr } = await client
          .from("pr_vendor_catalog")
          .select("clean_name,pack_text,catalog_price")
          .eq("vendor_id", vendorId)
          .not("clean_name", "is", null)
          .order("clean_name", { ascending: true })
          .range(from, from + page - 1);
        if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
        const rows = (cData ?? []) as NameCatalogRow[];
        bucket.push(...rows);
        if (rows.length < page) break;
        from += page;
      }
      vendorCatalogRows.set(vendorId, bucket);
    }
  }

  // P1 2c + P2 (2026-11-04): vendor-level sibling-expansion map, gated
  // by per-vendor reliability.
  //
  // P1 2c found the signal lives at the vendor level, not the item
  // level. P2 adds the gate: the global 2-corroborator threshold is
  // too strict at vendors that are perfectly consistent (Sysco: 96%
  // unanimity; 32 fills withheld) AND too loose at vendors that
  // reuse the same slashless string for genuinely different packs
  // (Shamrock: 30% unanimity, 0% at deep samples; 8 fills about half
  // of which would be wrong, worse than leaving the pack blank).
  //
  // Each vendor earns its own threshold from its own catalog record:
  //   deepRate < 0.80 (and vendor has deep groups) -> suppressed
  //   reliabilityRate >= 0.90                      -> 1 corroborator
  //   reliabilityRate <  0.70                      -> suppressed
  //   otherwise                                    -> 2 (unchanged)
  // Vendors with < 8 testable groups default to 2 (no record to judge).
  //
  // Corroborator definition (strict per P2 §2.1): a sibling item at
  // the same vendor whose SKU-matched catalog row's pack_text
  // contains a slash AND parses CLEANLY via parsePack. Unparseable
  // catalog packs are SKIPPED, not counted, and must not reject the
  // group. The round-2 implementation bailed on any parse failure,
  // which cost valid groups wherever one LBAV sibling slipped in.
  //
  // Trivial expansions (shape agrees with the invoice's naive parse)
  // are NOT recorded - applying them would flip pack_source and
  // pack_state on items whose pack is already correct (§0 defect).
  const siblingExpansions = new Map<string, {
    qty: number; size: number; uom: string; corroborators: number
  }>();
  type VendorMetrics = {
    testableGroups: number;
    unanimousGroups: number;
    deepGroups: number;        // >= 4 corroborators
    deepUnanimous: number;
    reliabilityRate: number | null;
    deepRate: number | null;
    thresholdUsed: number;     // 1, 2, or Number.POSITIVE_INFINITY
    suppressedByGate: number;  // groups that would fill under threshold 2 but got withheld
    recorded: number;          // groups that made it into siblingExpansions
  };
  const vendorMetrics = new Map<string, VendorMetrics>();
  {
    const vendorsInBatch = new Set(items.map((it) => it.vendor_id));
    if (vendorsInBatch.size > 0) {
      // Pull every (vendor, invoice_pack_text, catalog_pack_text)
      // corroboration row. Same shape as 2c.
      const corrPage = 1000;
      const corroborationRows: Array<{
        vendor_id: string;
        invoice_pack: string;
        catalog_pack: string;
      }> = [];
      for (const vendorId of vendorsInBatch) {
        let from = 0;
        for (;;) {
          const { data: cData, error: cErr } = await client
            .from("pr_vendor_items")
            .select("vendor_id,pack_text,item_number_norm,pack_override")
            .eq("vendor_id", vendorId)
            .is("pack_override", null)
            .not("pack_text", "is", null)
            .not("item_number_norm", "is", null)
            .range(from, from + corrPage - 1);
          if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
          const vendorItems = (cData ?? []) as Array<{
            vendor_id: string; pack_text: string | null; item_number_norm: string | null;
          }>;
          const slashlessVendorItems = vendorItems.filter(
            (r) => r.pack_text != null && isSlashlessWeightPack(r.pack_text)
          );
          if (slashlessVendorItems.length > 0) {
            const nums = Array.from(
              new Set(slashlessVendorItems.map((r) => r.item_number_norm!).filter(Boolean))
            );
            if (nums.length > 0) {
              for (let i = 0; i < nums.length; i += 500) {
                const slice = nums.slice(i, i + 500);
                const { data: catData, error: catErr } = await client
                  .from("pr_vendor_catalog")
                  .select("item_number_norm,pack_text")
                  .eq("vendor_id", vendorId)
                  .in("item_number_norm", slice)
                  .not("pack_text", "is", null);
                if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 });
                const byNorm = new Map<string, string>();
                for (const c of (catData ?? []) as Array<{ item_number_norm: string; pack_text: string | null }>) {
                  if (c.pack_text && c.pack_text.includes("/")) byNorm.set(c.item_number_norm, c.pack_text);
                }
                for (const r of slashlessVendorItems) {
                  const cat = r.item_number_norm ? byNorm.get(r.item_number_norm) : undefined;
                  if (!cat) continue;
                  corroborationRows.push({
                    vendor_id: vendorId,
                    invoice_pack: r.pack_text!.toUpperCase().trim(),
                    catalog_pack: cat,
                  });
                }
              }
            }
          }
          if (vendorItems.length < corrPage) break;
          from += corrPage;
        }
      }
      // Group by (vendor_id, invoice_pack). For each group collect
      // the PARSED corroborators (unparseable ones are skipped per
      // P2 §2.1 - "a row that fails to parse is skipped, not counted,
      // and must not reject the group").
      type Shape = { qty: number; size: number; uom: string };
      type Group = { vendor_id: string; invoice_pack: string; parses: Shape[] };
      const byKey = new Map<string, Group>();
      for (const r of corroborationRows) {
        const key = `${r.vendor_id}#${r.invoice_pack}`;
        let g = byKey.get(key);
        if (!g) {
          g = { vendor_id: r.vendor_id, invoice_pack: r.invoice_pack, parses: [] };
          byKey.set(key, g);
        }
        const p = parsePack(r.catalog_pack);
        if (p.qty != null && p.size != null && p.uom != null) {
          g.parses.push({ qty: p.qty, size: p.size, uom: p.uom });
        }
      }

      // Score each vendor from its own groups, then derive threshold.
      const groupsByVendor = new Map<string, Group[]>();
      for (const g of byKey.values()) {
        let list = groupsByVendor.get(g.vendor_id);
        if (!list) {
          list = [];
          groupsByVendor.set(g.vendor_id, list);
        }
        list.push(g);
      }
      const shapesEqual = (a: Shape, b: Shape) =>
        a.qty === b.qty && a.size === b.size && a.uom === b.uom;
      const isUnanimous = (parses: Shape[]) => {
        if (parses.length === 0) return false;
        const first = parses[0];
        for (let i = 1; i < parses.length; i += 1) if (!shapesEqual(parses[i], first)) return false;
        return true;
      };
      for (const [vendorId, groups] of groupsByVendor) {
        let testableGroups = 0;
        let unanimousGroups = 0;
        let deepGroups = 0;
        let deepUnanimous = 0;
        for (const g of groups) {
          if (g.parses.length >= 2) {
            testableGroups += 1;
            const u = isUnanimous(g.parses);
            if (u) unanimousGroups += 1;
            if (g.parses.length >= 4) {
              deepGroups += 1;
              if (u) deepUnanimous += 1;
            }
          }
        }
        const reliabilityRate = testableGroups > 0 ? unanimousGroups / testableGroups : null;
        const deepRate = deepGroups > 0 ? deepUnanimous / deepGroups : null;
        // P2 §2.2 gate, ordered as spec'd: deep check runs before the
        // rate checks because a vendor can look fine at two samples
        // and collapse at four.
        let thresholdUsed: number;
        if (testableGroups < 8) {
          thresholdUsed = 2;
        } else if (deepRate !== null && deepRate < 0.80) {
          thresholdUsed = Number.POSITIVE_INFINITY;
        } else if (reliabilityRate !== null && reliabilityRate >= 0.90) {
          thresholdUsed = 1;
        } else if (reliabilityRate !== null && reliabilityRate < 0.70) {
          thresholdUsed = Number.POSITIVE_INFINITY;
        } else {
          thresholdUsed = 2;
        }
        vendorMetrics.set(vendorId, {
          testableGroups,
          unanimousGroups,
          deepGroups,
          deepUnanimous,
          reliabilityRate,
          deepRate,
          thresholdUsed,
          suppressedByGate: 0,
          recorded: 0,
        });
      }

      // Record proven expansions subject to each vendor's threshold.
      // Trivial no-op expansions (shape == invoice's naive parse) are
      // NOT recorded - applying them would flip pack_source and
      // pack_state on an already-correct item (§0 defect from round 2).
      for (const [key, g] of byKey) {
        const metrics = vendorMetrics.get(g.vendor_id);
        if (!metrics) continue;
        const threshold = metrics.thresholdUsed;
        if (!Number.isFinite(threshold)) continue; // vendor suppressed
        if (g.parses.length < threshold) continue;
        if (!isUnanimous(g.parses)) continue;
        const shape = g.parses[0];
        // Trivial filter. invoice_pack is already UPPER-TRIM'd.
        const invP = parsePack(g.invoice_pack);
        const trivial =
          invP.qty === shape.qty && invP.size === shape.size && invP.uom === shape.uom;
        if (trivial) continue;
        // Count a "would have fired at threshold 2" group that got
        // through at threshold 1 as recorded, not suppressed. Only
        // Infinity-threshold vendors drive the suppressedByGate meter
        // and they never reach here.
        siblingExpansions.set(key, { ...shape, corroborators: g.parses.length });
        metrics.recorded += 1;
      }

      // Count suppression at Infinity-threshold vendors: how many
      // unanimous, non-trivial groups would have landed at threshold 2.
      for (const [vendorId, groups] of groupsByVendor) {
        const metrics = vendorMetrics.get(vendorId)!;
        if (Number.isFinite(metrics.thresholdUsed)) continue;
        for (const g of groups) {
          if (g.parses.length < 2) continue;
          if (!isUnanimous(g.parses)) continue;
          const shape = g.parses[0];
          const invP = parsePack(g.invoice_pack);
          if (invP.qty === shape.qty && invP.size === shape.size && invP.uom === shape.uom) continue;
          metrics.suppressedByGate += 1;
        }
      }
    }
  }

  // Prompt B: aggregate pr_price_observations into one Actuals record
  // per batch item. latest_unit_price keeps its "newest invoice_date
  // wins" semantics; sum_extended / sum_quantity / sum_weight are the
  // new blended inputs. unit_consistent is false when the lines mix
  // billed units (then quantity-derived tiers are skipped).
  const actualsByItem = new Map<string, Actuals>();
  // Prompt F counter: observations where unit_price == extended_price
  // and quantity != 1 (corrected to 1 inside the loop below).
  let quantityCorrectedToOne = 0;
  {
    const ids = items.map((it) => it.id);
    const perItem = new Map<
      string,
      {
        latest_date: string | null;
        latest_unit_price: number | null;
        sum_extended: number;
        sum_quantity: number;
        sum_extended_cased: number;
        sum_weight: number;
        sum_billed_units: number;
        sum_extended_priced: number;
        sum_extended_weight: number;
        sum_quantity_weight: number;
        unitCounts: Map<string, number>;
        n_lines: number;
      }
    >();
    const page = 1000;
    let from = 0;
    for (;;) {
      // N0b: countable observations read from the view; the view
      // excludes already-excluded, superseded, and deleted rows at
      // the DB layer so no client-side filter is needed.
      const { data: obsData, error: obsErr } = await client
        .from(COUNTABLE_OBSERVATIONS_VIEW)
        .select(
          "vendor_item_id,unit_price,invoice_date,quantity,extended_price,billed_unit,weight_line_value"
        )
        .in("vendor_item_id", ids)
        .order("invoice_date", { ascending: false, nullsFirst: false })
        .range(from, from + page - 1);
      if (obsErr) return NextResponse.json({ error: obsErr.message }, { status: 500 });
      const chunk = (obsData ?? []) as Array<{
        vendor_item_id: string;
        unit_price: number | null;
        invoice_date: string | null;
        quantity: number | null;
        extended_price: number | null;
        billed_unit: string | null;
        weight_line_value: number | null;
      }>;
      for (const o of chunk) {
        let entry = perItem.get(o.vendor_item_id);
        if (!entry) {
          entry = {
            latest_date: null,
            latest_unit_price: null,
            sum_extended: 0,
            sum_quantity: 0,
            sum_extended_cased: 0,
            sum_weight: 0,
            sum_billed_units: 0,
            sum_extended_priced: 0,
            sum_extended_weight: 0,
            sum_quantity_weight: 0,
            unitCounts: new Map(),
            n_lines: 0,
          };
          perItem.set(o.vendor_item_id, entry);
        }
        // latest_unit_price: newest invoice_date wins (rows arrive in
        // desc order; first non-null is the newest).
        if (
          o.unit_price != null &&
          Number.isFinite(Number(o.unit_price)) &&
          (entry.latest_date == null ||
            (o.invoice_date != null && o.invoice_date > entry.latest_date))
        ) {
          entry.latest_date = o.invoice_date ?? entry.latest_date;
          entry.latest_unit_price = Number(o.unit_price);
        }
        // Blended sums (count only strictly positive values).
        const ext = Number(o.extended_price ?? 0);
        const qtyRaw = Number(o.quantity ?? 0);
        const wt = Number(o.weight_line_value ?? 0);
        const up = Number(o.unit_price ?? 0);

        // Prompt F: extended = quantity * unit_price, so when unit_price
        // and extended_price are equal the quantity is 1 BY DEFINITION.
        // Any other value is an OCR mis-read - on BACON SLICED CANADIAN
        // STYLE it is the pack count (6 x 2 LB) leaking out of the
        // description into the quantity column, which made Tier C read
        // 58.85/12 = $4.90 as a CASE price and then divide by the 12 lb
        // pack again, landing at $0.409/lb.
        //
        // This holds whichever column OCR actually corrupted:
        //   quantity wrong -> 1 case @ $58.85            = $58.85/case
        //   extended wrong -> 12 cases, true ext 706.20  = $58.85/case
        // Both give the same case price, so the correction is safe
        // without deciding which field failed.
        //
        // Disjoint from Prompt E's isColumnCopy (measured: 0 overlap).
        const unitPriceIsLineTotal =
          Number.isFinite(up) && up > 0 &&
          Number.isFinite(ext) && ext > 0 &&
          Math.abs(up - ext) < 0.005 &&
          Number.isFinite(qtyRaw) &&
          Math.abs(qtyRaw - 1) > 0.005;

        const qty = unitPriceIsLineTotal ? 1 : qtyRaw;
        if (unitPriceIsLineTotal) quantityCorrectedToOne += 1;
        if (Number.isFinite(ext) && ext > 0) entry.sum_extended += ext;

        // Prompt E: OCR sometimes copies the extended-price column into
        // the quantity column. The fingerprint is unmistakable - the two
        // agree to the cent on a line whose dollar value is real - and the
        // consequence is a case price of exactly $1.00, because Tier C
        // computes sum_extended / sum_quantity. Live: TOMATO PASTE
        // CALIFORNIA qty 64.53 / ext 64.53 -> $1.00/case -> $0.0556/lb;
        // BISCUIT SS qty 76.49 / ext 76.49 -> $0.0300/lb.
        //
        // This test deliberately does NOT consult unit_price. On a
        // catch-weight line `quantity` legitimately holds POUNDS while
        // billed_unit still reads "case" - BEEF - TENDERLOIN 6LB AVG bills
        // qty 38.4 x $22.80 = $875.52 - and 92 such lines ($30,878) must
        // keep contributing. A reconciliation test would also re-break
        // ESSENTIA, which Prompt D released for exactly that reason.
        // Equality of quantity and extended is the only separating signal.
        // Prompt F: still reads the RAW quantity. Prompt E's fingerprint
        // is about the raw mis-read column; applying it to the corrected
        // qty (always 1 when the F path fires) would miss column copies.
        const isColumnCopy =
          Number.isFinite(qtyRaw) &&
          Number.isFinite(ext) &&
          ext > 2 &&
          Math.abs(qtyRaw - ext) < 0.01;

        // Paired, like the B1 and B2 aggregates: a line contributes its
        // quantity and its extended together or not at all, so Tier C can
        // never divide the full spend by a reduced quantity.
        if (
          Number.isFinite(qty) && qty > 0 &&
          Number.isFinite(ext) && ext > 0 &&
          !isColumnCopy
        ) {
          entry.sum_quantity += qty;
          entry.sum_extended_cased += ext;
        }
        // Prompt B2: only trust weight_line_value when the line's OWN
        // arithmetic confirms it is a weight: |ext - wt * up| <= 0.05.
        // Live data carries lines where this field is not a weight at
        // all (a single case of tortillas holding 459.63), which fed
        // Tier B a $0.08/lb price. Paired with its extended + quantity
        // so Tier B's numerator / denominator and pack derivation both
        // come from the same reconciled line set.
        const wtReconciles =
          Number.isFinite(wt) && wt > 0 &&
          Number.isFinite(up) && up > 0 &&
          Number.isFinite(ext) && ext > 0 &&
          Math.abs(ext - wt * up) <= 0.05;
        if (wtReconciles) {
          entry.sum_weight += wt;
          entry.sum_extended_weight += ext;
          entry.sum_quantity_weight +=
            Number.isFinite(qty) && qty > 0 ? qty : 0;
        }
        // Prompt B1 paired aggregates: only count a line's ext into
        // sum_extended_priced when it ALSO contributes to
        // sum_billed_units (unit_price > 0 AND ext > 0). Keeps the
        // Tier A numerator and denominator over the same line set.
        if (
          Number.isFinite(ext) && ext > 0 &&
          Number.isFinite(up) && up > 0 &&
          !isColumnCopy
        ) {
          entry.sum_billed_units += ext / up;
          entry.sum_extended_priced += ext;
        }
        // Count units for modal + consistency.
        const bu = o.billed_unit?.trim() ?? null;
        if (bu) entry.unitCounts.set(bu, (entry.unitCounts.get(bu) ?? 0) + 1);
        entry.n_lines += 1;
      }
      if (chunk.length < page) break;
      from += page;
    }
    for (const [id, e] of perItem) {
      let modal: string | null = null;
      let modalCount = 0;
      let total = 0;
      for (const [u, n] of e.unitCounts) {
        total += n;
        if (n > modalCount) {
          modalCount = n;
          modal = u;
        }
      }
      // unit_consistent: the modal unit covers every counted line.
      const unitConsistent = modal != null && modalCount === total && total > 0;
      actualsByItem.set(id, {
        latest_unit_price: e.latest_unit_price,
        sum_extended: e.sum_extended,
        sum_quantity: e.sum_quantity,
        sum_extended_cased: e.sum_extended_cased,
        sum_weight: e.sum_weight,
        sum_billed_units: e.sum_billed_units,
        sum_extended_priced: e.sum_extended_priced,
        sum_extended_weight: e.sum_extended_weight,
        sum_quantity_weight: e.sum_quantity_weight,
        billed_unit: modal,
        unit_consistent: unitConsistent,
        n_lines: e.n_lines,
      });
    }
  }

  // Prompt B cross-check pre-load: all active masters + every
  // confirmed vendor item's current price_estimate so we can blend
  // "the OTHERS on this master" cheaply. Done once per batch.
  const masterUomById = new Map<string, string | null>();
  {
    const { data: ingData, error: ingErr } = await client
      .from("pr_ingredients")
      .select("id,base_unit")
      .eq("status", "active");
    if (ingErr) return NextResponse.json({ error: ingErr.message }, { status: 500 });
    for (const r of (ingData ?? []) as Array<{ id: string; base_unit: string | null }>) {
      masterUomById.set(r.id, canonicalFromBaseUnit(r.base_unit));
    }
  }
  // Per-master array of {itemId, perBase converted to master's base_unit}.
  // perBase stays null when the stored value can't be converted into the
  // master's dimension - that item just doesn't contribute to the blend.
  const linkedByMaster = new Map<string, Array<{ itemId: string; perBase: number | null }>>();
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await client
        .from("pr_vendor_items")
        .select("id,ingredient_id,price_estimate")
        .eq("link_status", "confirmed")
        .not("ingredient_id", "is", null)
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const rows = (data ?? []) as Array<{
        id: string;
        ingredient_id: string | null;
        price_estimate: Record<string, unknown> | null;
      }>;
      for (const r of rows) {
        if (!r.ingredient_id) continue;
        const masterUom = masterUomById.get(r.ingredient_id) ?? null;
        const pe = r.price_estimate;
        const pbRaw = pe && pe.per_base != null ? Number(pe.per_base) : NaN;
        const storedUom = pe && typeof pe.base_uom === "string" ? pe.base_uom.toUpperCase() : null;
        let converted: number | null = null;
        if (
          Number.isFinite(pbRaw) &&
          pbRaw > 0 &&
          masterUom &&
          storedUom
        ) {
          converted = convertPer(pbRaw, storedUom, masterUom);
        }
        let list = linkedByMaster.get(r.ingredient_id);
        if (!list) {
          list = [];
          linkedByMaster.set(r.ingredient_id, list);
        }
        list.push({ itemId: r.id, perBase: converted });
      }
      if (rows.length < page) break;
      from += page;
    }
  }

  // Vendor-name lookup for the top-50 diff list.
  const vendorNameById = new Map<string, string>();
  if (dryRun) {
    const { data: vData } = await client.from("pr_vendors").select("id,name");
    for (const v of (vData ?? []) as Array<{ id: string; name: string }>) {
      vendorNameById.set(v.id, v.name);
    }
  }

  // Per-item processing. Writes are skipped when dryRun.
  const counts = { ok: 0, check: 0, none: 0, skipped: 0, nameMatched: 0, siblingMatched: 0 };
  const packStateTransitions: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const derivedPacks = { accepted: 0, rejectedByBounds: 0 };
  let tierBRejectedByBounds = 0;
  let gainedPerBase = 0;
  let lostPerBase = 0;
  let wouldBeFlags = 0;
  const topChanges: DryRunChange[] = [];

  for (const it of items) {
    if (it.pack_override !== null) {
      counts.skipped += 1;
      continue;
    }
    const skuKey = it.item_number_norm ? `${it.vendor_id}#${it.item_number_norm}` : null;
    let cat: { pack_text: string | null; catalog_price: number | null } | null =
      skuKey ? catalogByKey.get(skuKey) ?? null : null;
    let matchSource: "sku" | "catalog_name" | null = cat ? "sku" : null;
    // P1 §4: trigram-similarity score when matchSource='catalog_name'.
    // Carried onto the estimate so the panel and audit can show it.
    let matchScore: number | null = null;

    if (!cat) {
      // Trigram top match against the vendor's catalog. `bestTrigramMatch`
      // returns null when top < 0.55 OR when top ties with second (tie
      // rejection per §4.2). Within-vendor only - a cross-vendor
      // match is forbidden by the §4.1 rules.
      const rows = vendorCatalogRows.get(it.vendor_id) ?? [];
      const candidates = rows.map((r) => ({ key: r.clean_name ?? "", row: r }));
      const match = bestTrigramMatch(it.name, candidates, NAME_MATCH_MIN);
      if (match) {
        cat = {
          pack_text: match.row.pack_text,
          catalog_price: match.row.catalog_price,
        };
        matchSource = "catalog_name";
        matchScore = match.score;
      }
    }

    // P1 correction 2c: sibling-expansion apply. An orphan slashless
    // item (no catalog of its own) inherits a proven expansion from
    // its same-vendor siblings. Builds a synthetic catalog pack_text
    // so estimatePerUnit treats it the same way it would treat any
    // other catalog hit - the only difference is pack_source gets
    // stamped 'catalog_sibling' after estimation to keep the origin
    // traceable. The per-vendor threshold (1, 2, or Infinity per P2
    // §2.2) is applied upstream when siblingExpansions is built, so
    // reaching this point means the expansion already cleared the
    // vendor's reliability gate.
    let siblingExpansionApplied: { qty: number; size: number; uom: string; corroborators: number } | null = null;
    if (!cat && !matchSource && isSlashlessWeightPack(it.pack_text)) {
      const sKey = `${it.vendor_id}#${it.pack_text!.toUpperCase().trim()}`;
      const exp = siblingExpansions.get(sKey);
      if (exp) {
        siblingExpansionApplied = exp;
        cat = {
          pack_text: `${exp.qty}/${exp.size} ${exp.uom}`,
          catalog_price: null,
        };
        // matchSource stays null - the catalog row did not come from
        // THIS item's own SKU or name lookup. pack_source will be
        // stamped 'catalog_sibling' on the output instead.
      }
    }

    const actuals = actualsByItem.get(it.id) ?? null;

    // Prompt B2 belt-and-braces: compute what Tier B would emit (matched
    // spend / matched weight) and reject if it is outside $0.05-$200/lb.
    // We can't modify the estimator result directly, so scrub the weight
    // aggregates on a per-item copy of actuals - the estimator then
    // naturally falls through to the next catch-weight tier.
    const actualsForEstimate: typeof actuals = actuals ? { ...actuals } : actuals;
    if (
      actuals &&
      actuals.sum_weight > 0 &&
      actuals.sum_extended_weight > 0
    ) {
      const candidate = actuals.sum_extended_weight / actuals.sum_weight;
      if (
        !Number.isFinite(candidate) ||
        candidate < TIER_B_MIN_PER_LB ||
        candidate > TIER_B_MAX_PER_LB
      ) {
        tierBRejectedByBounds += 1;
        if (actualsForEstimate) {
          actualsForEstimate.sum_weight = 0;
          actualsForEstimate.sum_extended_weight = 0;
          actualsForEstimate.sum_quantity_weight = 0;
        }
      }
    }

    const result = estimatePerUnit({
      pack_text: it.pack_text,
      catch_weight: it.catch_weight,
      latest_unit_price: actuals?.latest_unit_price ?? null,
      catalog_pack_text: cat?.pack_text ?? null,
      catalog_price: cat?.catalog_price != null ? Number(cat.catalog_price) : null,
      actuals: actualsForEstimate,
    });

    const parsed = result.parsed;
    const baseEstimate = result.estimate;

    const estimate = { ...baseEstimate } as typeof baseEstimate & {
      match_source?: "sku" | "catalog_name";
      match_score?: number;
    };
    if (matchSource) {
      estimate.match_source = matchSource;
      if (matchSource === "catalog_name") {
        const scoreStr = matchScore != null ? matchScore.toFixed(2) : "n/a";
        const nameNote = `matched to catalog by name (trigram similarity ${scoreStr}); verify`;
        estimate.note = baseEstimate.note ? `${baseEstimate.note}; ${nameNote}` : nameNote;
        if (matchScore != null) estimate.match_score = matchScore;
      }
    }
    // P1 correction 2c: stamp sibling-expansion origin AFTER
    // estimatePerUnit so the estimator's math (which just saw a
    // synthetic catalog pack) is preserved, but the pack_source
    // reflects where the pack really came from. packState='check'
    // is forced further below by the pack_source==='catalog_sibling'
    // branch. The note names the sibling corroboration count so a
    // reviewer knows how many invoices back the expansion.
    if (siblingExpansionApplied) {
      estimate.pack_source = "catalog_sibling";
      const n = siblingExpansionApplied.corroborators;
      const sibNote = `inferred from ${n} same-vendor sibling${n === 1 ? "" : "s"} sharing invoice pack "${(it.pack_text ?? "").trim()}" with catalog pack "${siblingExpansionApplied.qty}/${siblingExpansionApplied.size} ${siblingExpansionApplied.uom}"; verify`;
      estimate.note = baseEstimate.note ? `${baseEstimate.note}; ${sibNote}` : sibNote;
    }

    // Prompt B pack derivation (Prompt B2 denominator): when parsed
    // pack is unusable and we have reconciled weight + its paired
    // quantity, derive the pack size as Σ matched weight / Σ matched
    // quantity, in LB. Sanity bounds reject outliers.
    let derivedPackLb: number | null = null;
    let packNote: string | null = parsed.note ?? null;
    const parseUnusable =
      parsed.confidence === "none" ||
      parsed.total_base == null ||
      parsed.total_base <= 0;
    if (
      parseUnusable &&
      actuals &&
      actuals.unit_consistent &&
      actuals.sum_weight > 0 &&
      actuals.sum_quantity_weight > 0
    ) {
      const d = actuals.sum_weight / actuals.sum_quantity_weight;
      if (
        Number.isFinite(d) &&
        d >= DERIVED_PACK_MIN_LB &&
        d <= DERIVED_PACK_MAX_LB
      ) {
        derivedPackLb = d;
        packNote = `pack derived: ${actuals.sum_weight.toFixed(2)} lb / ${actuals.sum_quantity_weight} units = ${d.toFixed(2)} lb`;
      } else if (Number.isFinite(d)) {
        derivedPacks.rejectedByBounds += 1;
      }
    }
    const derivedPackUsed = derivedPackLb != null;

    // P2 §2.4: when the fill came from a sibling expansion, overwrite
    // packNote with the evidence-strength phrase for the review
    // surface ("inferred from N similar items at this vendor").
    // Separate from estimate.note; both land on the row but the panel
    // prefers packNote for pack-origin context.
    if (siblingExpansionApplied) {
      const n = siblingExpansionApplied.corroborators;
      packNote = `inferred from ${n} similar item${n === 1 ? "" : "s"} at this vendor; verify`;
    }

    // Prompt B2: pack_state describes the PACK, not the price. A
    // 'derived' price on a cleanly-parsed pack is still a clean pack -
    // it must not flip to 'check'. Price confidence stays on
    // price_estimate.confidence and the "from spend" chip. An inferred
    // (derived) pack is always 'check' since no human has read it.
    const effectiveConf =
      estimate.confidence === "derived"
        ? parsed.confidence === "high"
          ? "high"
          : "low"
        : estimate.confidence;
    // P1 §4.2 tiered packState for catalog-name matches:
    //   score >= 0.75  AND pack parsed cleanly -> 'ok'
    //   score 0.55-0.75  OR catalog pack failed to parse -> 'check'
    // Pre-P1 (Phase 1.9) forced all catalog-name hits to 'check';
    // that was a correct conservative default when matching was EXACT
    // only. Trigram >= 0.75 has been verified by hand against five
    // production samples (see P1 report), so the high tier earns 'ok'.
    const highSimilarityNameMatch =
      matchSource === "catalog_name" && matchScore != null && matchScore >= NAME_MATCH_HIGH;
    let packState: "ok" | "check" | "none" =
      matchSource === "catalog_name"
        ? highSimilarityNameMatch && effectiveConf === "high"
          ? "ok"
          : "check"
        : derivedPackUsed
          ? "check"
          : effectiveConf === "high"
            ? "ok"
            : effectiveConf === "low"
              ? "check"
              : "none";

    // P1 correction 2c (2026-11-04): if this item was filled via the
    // vendor-sibling expansion (slashless invoice + corroborated
    // sibling expansion applied below), mark it check so the inferred
    // pack is visible for review. The fix lives in the sibling-apply
    // block (search for "sibling expansion") rather than here, but
    // the flag lands on packState.
    if (estimate.pack_source === "catalog_sibling") {
      packState = "check";
    }

    // When derived pack is accepted, override the pack cols. The
    // 'check' state is already handled above (derivedPackUsed branch).
    const packQtyOut = derivedPackLb != null ? 1 : parsed.qty;
    const packSizeOut = derivedPackLb != null ? derivedPackLb : parsed.size;
    const packUomOut = derivedPackLb != null ? "LB" : parsed.uom;
    if (derivedPackLb != null) {
      derivedPacks.accepted += 1;
    }

    // ----- Dry-run diffing before any write -----
    const oldPackState = (it.pack_state ?? "none") as string;
    const oldPe = it.price_estimate ?? null;
    const oldPerBaseRaw = oldPe && oldPe.per_base != null ? Number(oldPe.per_base) : NaN;
    const oldPerBase =
      Number.isFinite(oldPerBaseRaw) && oldPerBaseRaw > 0 ? oldPerBaseRaw : null;
    const oldSource =
      oldPe && typeof oldPe.case_price_source === "string"
        ? (oldPe.case_price_source as string)
        : null;
    const newPerBase =
      estimate.per_base != null && Number.isFinite(estimate.per_base) && estimate.per_base > 0
        ? estimate.per_base
        : null;
    const newSource = (estimate.case_price_source ?? null) as string | null;

    if (dryRun) {
      const transitionKey =
        oldPackState === packState ? "unchanged" : `${oldPackState}->${packState}`;
      packStateTransitions[transitionKey] =
        (packStateTransitions[transitionKey] ?? 0) + 1;
      if (oldPerBase == null && newPerBase != null) gainedPerBase += 1;
      if (oldPerBase != null && newPerBase == null) lostPerBase += 1;
      const srcKey = newSource ?? "(none)";
      bySource[srcKey] = (bySource[srcKey] ?? 0) + 1;
      if (oldPerBase != null && newPerBase != null) {
        const ratio = newPerBase >= oldPerBase ? newPerBase / oldPerBase : oldPerBase / newPerBase;
        if (ratio >= 1.5) {
          // keep the top candidates; absolute threshold trims obvious noise
          topChanges.push({
            id: it.id,
            name: it.name,
            vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
            old_per_base: oldPerBase,
            new_per_base: newPerBase,
            ratio,
            old_source: oldSource,
            new_source: newSource,
          });
        }
      } else if ((oldPerBase == null) !== (newPerBase == null)) {
        topChanges.push({
          id: it.id,
          name: it.name,
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          old_per_base: oldPerBase,
          new_per_base: newPerBase,
          ratio: Number.POSITIVE_INFINITY,
          old_source: oldSource,
          new_source: newSource,
        });
      }
    }

    // ----- Cross-check: would this flag? Only when ingredient linked AND
    // the row isn't already flagged (we never overwrite a human flag). -----
    let wouldFlag = false;
    let xcheckNote: string | null = null;
    if (
      it.ingredient_id &&
      !it.flagged &&
      newPerBase != null &&
      estimate.base_uom
    ) {
      const masterUom = masterUomById.get(it.ingredient_id) ?? null;
      if (masterUom) {
        const list = linkedByMaster.get(it.ingredient_id) ?? [];
        const others = list.filter(
          (x) => x.itemId !== it.id && x.perBase != null
        );
        if (others.length >= CROSS_CHECK_MIN_OTHERS) {
          // S3: survivor-mean, not raw mean. A single wild peer must
          // not drag the reference away from the real centre of the
          // master. Below OUTLIER_MIN peers (3), nothing to be a
          // median of; include everything.
          const blend = peerSurvivorMean(others.map((x) => x.perBase as number));
          if (blend != null && Number.isFinite(blend) && blend > 0) {
            // Convert this item's new per_base into the master's unit
            // for the comparison. Dimension mismatch -> don't flag
            // (unit mismatch has its own signal elsewhere).
            const mine = convertPer(newPerBase, estimate.base_uom, masterUom);
            if (mine != null) {
              const ratio = mine >= blend ? mine / blend : blend / mine;
              if (ratio > CROSS_CHECK_THRESHOLD) {
                wouldFlag = true;
                xcheckNote = `price sanity: $${mine.toFixed(2)}/${masterUom.toLowerCase() === "floz" ? "fl oz" : masterUom.toLowerCase()} vs $${blend.toFixed(2)}/${masterUom.toLowerCase() === "floz" ? "fl oz" : masterUom.toLowerCase()} blend across ${others.length} linked items`;
              }
            }
          }
        }
      }
    }
    if (wouldFlag) wouldBeFlags += 1;

    // ----- Write (skipped on dryRun) -----
    if (dryRun) {
      // Count the "effective" outcome into counts so Chat-Claude sees
      // the mapped totals too.
      if (packState === "ok") counts.ok += 1;
      else if (packState === "check") counts.check += 1;
      else counts.none += 1;
      if (matchSource === "catalog_name") counts.nameMatched += 1;
      if (siblingExpansionApplied) counts.siblingMatched += 1;
      continue;
    }

    const updatePayload: Record<string, unknown> = {
      pack_qty: packQtyOut,
      pack_size: packSizeOut,
      pack_uom: packUomOut,
      pack_state: packState,
      price_estimate: estimate,
    };
    if (derivedPackLb != null || siblingExpansionApplied) {
      // pack_note is a free-text annotation on pr_vendor_items; harmless
      // to overwrite with each run (same inputs -> same note). P2 §2.4
      // extends the write to sibling-applied rows so the review
      // surface can show the evidence-strength phrase.
      updatePayload.pack_note = packNote;
    }

    // P1 §5 (provenance): record the row's pre-write state so the
    // pr_events write below carries a real `before` payload. The
    // backfill is historically one of the write paths that has emitted
    // events without `before` populated - the AI-accuracy ledger
    // measurement called that out as the reason matcher precision
    // cannot be audited. P1 fixes it for pack_filled events.
    const before = {
      pack_qty: it.price_estimate ? ((it.price_estimate as Record<string, unknown>).pack_qty ?? null) : null,
      pack_size: null as unknown,
      pack_uom: null as unknown,
      pack_state: it.pack_state ?? null,
      pack_source: oldPe && typeof oldPe.pack_source === "string" ? oldPe.pack_source : null,
      match_source: oldPe && typeof oldPe.match_source === "string" ? oldPe.match_source : null,
      match_score: oldPe && typeof oldPe.match_score === "number" ? oldPe.match_score : null,
    };
    // pr_vendor_items.pack_qty / pack_size / pack_uom are the authoritative
    // pre-write pack fields (price_estimate does not store them). Re-select
    // the single row to avoid a race with another writer - cheap at one
    // row per fill.
    {
      const { data: liveRow, error: liveErr } = await client
        .from("pr_vendor_items")
        .select("pack_qty,pack_size,pack_uom")
        .eq("id", it.id)
        .maybeSingle();
      if (!liveErr && liveRow) {
        before.pack_qty = (liveRow as { pack_qty?: unknown }).pack_qty ?? null;
        before.pack_size = (liveRow as { pack_size?: unknown }).pack_size ?? null;
        before.pack_uom = (liveRow as { pack_uom?: unknown }).pack_uom ?? null;
      }
    }

    const { error: upErr } = await client
      .from("pr_vendor_items")
      .update(updatePayload)
      .eq("id", it.id)
      .is("pack_override", null);
    if (upErr) {
      counts.skipped += 1;
      continue;
    }
    if (packState === "ok") counts.ok += 1;
    else if (packState === "check") counts.check += 1;
    else counts.none += 1;
    if (matchSource === "catalog_name") counts.nameMatched += 1;
    // Q2 §5.1: the siblingMatched counter was only bumped inside the
    // dryRun branch (at :1174), so a live run reported siblingMatched=0
    // while 115 fills landed on first production run. Same shape as
    // the other counters (ok/check/none/nameMatched) which were
    // already incremented on both paths. Live now matches dry-run.
    if (siblingExpansionApplied) counts.siblingMatched += 1;

    // P1 §5: emit pack_filled event with BOTH before and after
    // populated. Only when the fill actually CHANGED something - no
    // noise event when the backfill would have written the same row
    // for the Nth time.
    const after = {
      pack_qty: packQtyOut ?? null,
      pack_size: packSizeOut ?? null,
      pack_uom: packUomOut ?? null,
      pack_state: packState,
      pack_source: estimate.pack_source ?? null,
      match_source: estimate.match_source ?? null,
      match_score: estimate.match_score ?? null,
    };
    const beforeStr = JSON.stringify(before);
    const afterStr = JSON.stringify(after);
    if (beforeStr !== afterStr) {
      // Non-blocking: if the event write fails, the pack fill already
      // landed. Event is for audit, not for the fill.
      await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: it.id,
        kind: "pack_filled",
        before,
        after,
        actor: "pack-backfill",
      });
    }

    // Cross-check write: flag only. Guard again on the row being
    // currently unflagged (defense in depth against a race). We write
    // flagged_by='price-check' so the Overview panel surfaces the
    // source distinctly from human flags.
    if (wouldFlag && xcheckNote) {
      const { error: flagErr } = await client
        .from("pr_vendor_items")
        .update({
          flagged: true,
          flag_note: xcheckNote,
          flagged_by: "price-check",
          flagged_at: new Date().toISOString(),
        })
        .eq("id", it.id)
        .eq("flagged", false);
      if (flagErr) {
        // Non-fatal; the price write already landed.
        // eslint-disable-next-line no-console
        console.warn(`price-check flag failed on ${it.id}: ${flagErr.message}`);
      }
    }
  }

  const done = items.length < BATCH;

  // Trim top-changes to the top 50 largest ratios (both directions).
  if (dryRun) {
    topChanges.sort((a, b) => {
      // sort by abs(log(ratio)) desc; infinities (gain/lose per_base)
      // dominate
      const aa = Number.isFinite(a.ratio) ? Math.abs(Math.log(a.ratio)) : Infinity;
      const bb = Number.isFinite(b.ratio) ? Math.abs(Math.log(b.ratio)) : Infinity;
      return bb - aa;
    });
    topChanges.length = Math.min(topChanges.length, 50);
  }

  // P2 §2.5: per-vendor reliability metrics in the response body.
  // "A run that writes nothing at a vendor must say why in its own
  // response body" - so every vendor present in the batch surfaces
  // with its testableGroups, reliabilityRate, deepRate, thresholdUsed
  // and suppressedByGate. Infinity is JSON-safe only as a string;
  // emit "Infinity" for suppressed vendors.
  const vendorReliability: Record<string, {
    testableGroups: number;
    reliabilityRate: number | null;
    deepGroups: number;
    deepRate: number | null;
    thresholdUsed: number | "Infinity";
    suppressedByGate: number;
    recorded: number;
  }> = {};
  for (const [vendorId, m] of vendorMetrics) {
    vendorReliability[vendorId] = {
      testableGroups: m.testableGroups,
      reliabilityRate: m.reliabilityRate,
      deepGroups: m.deepGroups,
      deepRate: m.deepRate,
      thresholdUsed: Number.isFinite(m.thresholdUsed) ? m.thresholdUsed : "Infinity",
      suppressedByGate: m.suppressedByGate,
      recorded: m.recorded,
    };
  }

  const response: Record<string, unknown> = {
    ok: true,
    done,
    dryRun,
    processed: items.length,
    nextOffset: offset + items.length,
    counts,
    nameMatched: counts.nameMatched,
    siblingMatched: counts.siblingMatched,
    vendorReliability,
  };
  if (dryRun) {
    response.dryRunSummary = {
      packStateTransitions,
      gainedPerBase,
      lostPerBase,
      bySource,
      derivedPacks,
      tierBRejectedByBounds,
      quantityCorrectedToOne,
      wouldBeFlags,
      topChanges,
    };
  }
  return NextResponse.json(response);
}
