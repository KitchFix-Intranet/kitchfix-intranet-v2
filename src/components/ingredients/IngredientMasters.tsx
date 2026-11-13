// Master-ingredient list page. Server component: loads every active
// pr_ingredients row and every confirmed pr_vendor_items row linked
// to one, groups the items under each master, and computes:
//   - linkedCount
//   - usd12m total (sum of pr_vendor_items.usd_12m)
//   - avg / min / max per-base from price_estimate.per_base
//   - base_uom (most common across the linked set)
//   - bad-pack flags (max/min spread > 3x, or avg outside a sane
//     band for the base_uom, or unit mismatch when the stored
//     per_base dimension differs from the master's base_unit)
// All per-row rollups computed on read; there's no stored master
// price column. Masters with 0 linked items still render.
//
// The display + search / sort / category / resale toggle filtering
// is a client island (IngredientMastersFilter) that receives the
// already-aggregated server data. Workbench shape as of Prompt Q1:
// list on the left, persistent detail pane on the right (the old
// <details> accordion is gone). The pane can write base_unit back
// via /api/review/set-base-unit - see Prompt R1.

import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import { IdentBand } from "@/components/ui/IdentBand";
import {
  IngredientMastersFilter,
  type MasterRow,
  type MasterLinkedItem,
  type MasterIssue,
  type LensStats,
} from "./IngredientMastersFilter";
import "./ingredients.css";
import "./review.css";
import "./table.css";
import "./chips.css";
import "./ingredients-tab.css";

type Ingredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
  base_unit: string;
  // B1: allergen three-state fields. Null reviewed_at = unreviewed
  // (must render "Check allergens" at every surface).
  allergens: string[];
  allergens_reviewed_by: string | null;
  allergens_reviewed_at: string | null;
  // N6: usual measure of one each. Only meaningful on each-costed
  // masters; null everywhere else.
  each_measure_qty: number | null;
  each_measure_uom: string | null;
  each_measure_source: string | null;
  // M2 §3.7 amendment 1: yield columns ride on MasterRow.
  yield_pct: number | null;
  yield_source: string | null;
};

type LinkedItemRow = {
  id: string;
  vendor_id: string;
  ingredient_id: string | null;
  name: string;
  usd_12m: number | null;
  price_estimate: {
    per_base?: number | null;
    base_uom?: string | null;
    confidence?: string | null;
  } | null;
  // S3: carried so linkedItems can label hand-set prices on the
  // outlier chip ("outlier · excluded · set by hand"). Reads
  // isPriceManualOverride(pack_override) without a cross-dimension
  // ingredient check - the label is about provenance, not blend math.
  pack_override: unknown;
  // G1: tier on the item. null is standard; 'premium' is the only
  // sanctioned non-null value today. The master rolls up three
  // prices filtered by this field.
  grade: string | null;
  // N6: per-item each measure override. Null for most rows.
  each_measure_qty: number | null;
  each_measure_uom: string | null;
  // M1 R2 fix 1: optional on the type so pre-0019 the SELECT omits
  // these columns; post-0019 the measures-world path derives the
  // item's eachMeasure from case_weight_lb + the pack shape.
  case_weight_lb?: number | null;
  pack_qty?: number | null;
  pack_size?: number | null;
  pack_uom?: string | null;
};

// M2: blendStats, medianOf, OUTLIER_RATIO + OUTLIER_MIN moved to
// src/lib/ingredients/blend.ts so the one blend module is importable
// from server and client. buildLensStats also lives there now; the
// blended lens runs the outlier rule PER GRADE and unions survivors
// (Premium is compared with Premium, per Kevin's §2.2 ruling). The
// Standard and Premium lenses stay partition-first (byte-identical to
// pre-M2). Imports at the top of this file.

type VendorRow = { id: string; name: string };

// Sane $/base bands used to catch outliers that single-link items
// miss by the spread rule. Loose bounds; a hit is a soft "look here",
// not a hard assertion. Keyed by the MASTER's base_unit (the source
// of truth), after we convert the per-base values to that unit.
//
// B3 (2026-11-04): the band's VALUE and thresholds are unchanged.
// What changed is WHEN it fires:
//   Rule 1 - if two or more distinct vendors agree on the price
//            (same 3x threshold the Spread flag uses), the band is
//            suppressed. Vendor agreement outranks population-level
//            comparison; the band becomes the fallback for when
//            there is no second opinion.
//   Rule 2 - never fire the band for count units (EA/DZ). "Each"
//            spans eggs, bottled water and case-priced items; the
//            typical-price comparison is meaningless by construction.
//   Spread, Coverage and Unit are untouched.
const BANDS: Record<string, { low: number; high: number }> = {
  LB: { low: 0.5, high: 100 },
  OZ: { low: 0.03, high: 6 },
  FLOZ: { low: 0.01, high: 5 },
  GAL: { low: 1, high: 200 },
  EA: { low: 0.1, high: 25 },
  DZ: { low: 1, high: 60 },
};

// B3: the "wide spread" threshold, shared between the Spread flag
// (ratioFlag) and the band's corroboration check. "Vendors agree" IS
// the Spread threshold - do not duplicate the number. Any future
// tuning updates both callers.
const SPREAD_RATIO_MAX = 3;

// B3: count units where the typical-price comparison is meaningless
// by construction - a case-priced sauce and a bottle of water are
// both "each," and the population spans two orders of magnitude.
// `lb` and `gal` keep the band.
const BAND_SUPPRESS_UNITS = new Set<string>(["EA", "DZ"]);

// B4: "live" vendor-item status set. The price rollup counts only
// items in this set - archived / not_food / duplicate / one_off are
// NOT live and must not contribute to a master's items, usd_12m,
// priced set, or linkedItems list. Matches the vendor-items UI's
// working-set definition (status IN ('active','resale') is what the
// Unlinked / Catch weight / No item number segments all filter on).
// Factored out so B4's empty-master check and the rollup read the
// same source of truth. Pre-B4 the server query filtered only on
// link_status='confirmed', which let archived items with a stale
// confirmed link flow through the mean / min / max / spread; this
// is the bug fix the "define live once" instruction names.
const LIVE_STATUSES: readonly string[] = ["active", "resale"];

// S5: convertPer / canonicalFromBaseUnit live in pack.ts now so the
// item panel's Result + Read-as can read the same converter the
// master list uses - a fl-oz price displayed as $/gal here must line
// up with the same price displayed as $/gal in the item panel.
// DIM_BY_UOM / normUom still needed below for the item-dim-vs-master-dim
// mismatch classification (an orthogonal use the item panel does not share).
import { DIM_BY_UOM, BASE_BY_DIM, normUom, convertPer, canonicalFromBaseUnit } from "@/lib/ingredients/pack";
import { isMeasuresWorld, readAllMeasures } from "@/lib/ingredients/measuresRead";
import { shapeIngredientEachFromMeasures, shapeItemEachFromCaseWeight } from "@/lib/ingredients/measuresShape";
import { priceInUnit, reachableUnits, sizesDifferFlags, type Measure } from "@/lib/ingredients/measures";
import {
  OUTLIER_RATIO,
  OUTLIER_MIN,
  blendStats,
  buildLensStats,
  type BlendItem,
} from "@/lib/ingredients/blend";
import { isPriceManualOverride } from "./itemTypes";

// R2: this workbench powers two tabs. `mode="recipe"` is the Ingredients
// tab (resale = false); `mode="resale"` is the new Resale tab (resale =
// true). The split happens server-side on pr_ingredients.resale so each
// consumer gets a pre-filtered list - no new write path, no new query
// shape, and the filter rail / editor / item-panel chain all run
// unchanged. The flip of a master's resale flag in the editor is what
// moves it between tabs on the next router.refresh() (see
// DetailPanel's IngredientBlock + the existing /api/review/resale
// cascade).
export async function IngredientMasters({ mode = "recipe" }: { mode?: "recipe" | "resale" } = {}) {
  const client = serviceClient();

  // Masters. Server-side split on `resale` - one list per tab; the
  // combined count of recipe + resale masters equals the previous
  // combined total (every master has `resale` set, defaults to false).
  const { data: ingData, error: ingErr } = await client
    .from("pr_ingredients")
    // N6: swap N5's avg_weight_lb/source for the N6 each-measure trio.
    .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source,yield_pct,yield_source")
    .eq("status", "active")
    .eq("resale", mode === "resale")
    .order("name");
  if (ingErr) throw ingErr;
  const rawIngredients = (ingData ?? []) as Ingredient[];

  // M1 R2 fix 1: detect the migration world once. In measures-world
  // the item SELECT below also carries case_weight_lb + pack_qty +
  // pack_size + pack_uom so the per-item eachMeasure shape can be
  // derived without a second query.
  const measuresWorld = await isMeasuresWorld(client);

  // Confirmed vendor items (paginated at 1000 - PostgREST db-max-rows cap).
  const LINKED_SELECT = measuresWorld
    ? "id,vendor_id,ingredient_id,name,usd_12m,price_estimate,pack_override,grade,each_measure_qty,each_measure_uom,case_weight_lb,pack_qty,pack_size,pack_uom"
    : "id,vendor_id,ingredient_id,name,usd_12m,price_estimate,pack_override,grade,each_measure_qty,each_measure_uom";
  const linked: LinkedItemRow[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select(LINKED_SELECT)
      .eq("link_status", "confirmed")
      .in("status", LIVE_STATUSES) // B4: archived/not_food/duplicate/one_off never reach the rollup
      .not("ingredient_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    // Cast via unknown: Supabase JS select-string type parser cannot
    // statically type a template-literal SELECT.
    const chunk = (data ?? []) as unknown as LinkedItemRow[];
    linked.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }

  // M1 R3 fix 1: paginated full-table read; no id filter so 506 active
  // ingredients in recipe mode do not land on a PostgREST URL.
  const measuresByIngredient = measuresWorld
    ? await readAllMeasures(client)
    : new Map<string, never>();
  const ingredients: Ingredient[] = rawIngredients.map((r) => {
    if (!measuresWorld) return r;
    const shaped = shapeIngredientEachFromMeasures(measuresByIngredient.get(r.id) ?? []);
    return {
      ...r,
      each_measure_qty: shaped.qty,
      each_measure_uom: shaped.uom,
      each_measure_source: shaped.source,
    };
  });

  // Vendors (small, read once).
  const { data: vData } = await client.from("pr_vendors").select("id,name");
  const vendorNameById = new Map(
    ((vData ?? []) as VendorRow[]).map((v) => [v.id, v.name])
  );

  // Group linked items under their master.
  const byMaster = new Map<string, LinkedItemRow[]>();
  for (const it of linked) {
    if (!it.ingredient_id) continue;
    let list = byMaster.get(it.ingredient_id);
    if (!list) {
      list = [];
      byMaster.set(it.ingredient_id, list);
    }
    list.push(it);
  }

  // Build the master rows + the per-master linked-items projection
  // the client renders in the <details> expand. All linked per-base
  // values are converted to the MASTER's base_unit before averaging
  // and band-checking; items whose stored base_uom belongs to a
  // different dimension are flagged as a unit mismatch (strong bad-
  // pack signal; e.g. Bottled water's per_base stored under LB when
  // its master is 'each', or Milk's per_base stored under FLOZ when
  // its master is 'gal' - the FLOZ -> GAL case converts cleanly; the
  // LB -> EA case doesn't and flags).
  const rows: MasterRow[] = ingredients.map((m) => {
    const items = byMaster.get(m.id) ?? [];
    const masterUom = canonicalFromBaseUnit(m.base_unit);
    // S3: collect {id, v} so blendStats can tag exclusions back to
    // the item that owns each priced value.
    // G1: each entry also carries its grade so the same priced set
    // feeds three subset rollups below (blended / standard /
    // premium). Null is standard; 'premium' is the only sanctioned
    // non-null value today - any stray third value is treated as
    // standard by the UI rule.
    // G2: each priced entry also carries `usd` for the spend-weighted
    // blend. Plain `usd` from pr_vendor_items.usd_12m - no re-shape;
    // the weighting is in blendStats.
    const priced: Array<{ id: string; v: number; grade: string | null; usd: number }> = [];
    // B3: per-priced-item vendor map so the band's corroboration
    // check can count DISTINCT VENDORS on the survivors (rows that
    // actually contribute to the mean). Using the same filter as
    // `priced` - the mean's set IS the corroboration set. Important
    // subtlety: this must count vendors, not vendor items. Two
    // Sysco rows is one opinion, not two; a master whose only
    // priced items are Sysco is NOT corroborated.
    const vendorByPricedItem = new Map<string, string>();
    // M2: items that cannot reach the ingredient's base_unit through
    // the measures. Replaces mismatchedItemIds. The pack is fine; what
    // is missing is a measure on the ingredient. UI copy at
    // panel/attention.tsx + the per-item status chip.
    const needsMeasureItemIds = new Set<string>();
    let usd = 0;
    // Spend on items that contribute NOTHING to the master's price -
    // either no usable per_base at all, or no path to base_unit. This
    // is the money the headline $/unit does not describe. (Outliers do
    // NOT count as unpriced: their spend IS covered by a confirmed
    // link; the blend just leaves them out of its own math.)
    let unpricedUsd = 0;
    // How many priced items sit in each dimension, regardless of
    // whether they converted. Used ONLY to suggest a base_unit when the
    // master's own unit is the odd one out; it never touches the blend.
    const dimTally = new Map<string, number>();
    // M2: measures for this ingredient, read in one bulk query above.
    const ingMeasures: Measure[] = measuresWorld ? (measuresByIngredient.get(m.id) ?? []) : [];
    // M2 R2 rule 2: sized packs whose piece sizes disagree within one
    // kind (max > 1.1 * min) are "sizes_differ" - priced, shown, not
    // in any lens, spend counted as unpriced. Runs BEFORE the outlier
    // rule so an "each" that means two things never reaches the
    // blend math at all. Only fires for count-costed ingredients
    // (base_unit each / dozen).
    const sizesDifferIds = sizesDifferFlags(
      items.map((it) => ({
        id: it.id,
        packQty: it.pack_qty ?? null,
        packSize: it.pack_size ?? null,
        packUom: it.pack_uom ?? null,
      })),
      ingMeasures,
      m.base_unit,
    );
    // Per-item price in the ingredient's base_unit, keyed by item.id.
    // Null when the item cannot reach base_unit (needs a measure).
    const perBaseInIngUnitById = new Map<string, number | null>();
    for (const it of items) {
      const itUsd = Number(it.usd_12m ?? 0);
      usd += itUsd;
      const rawV = it.price_estimate?.per_base;
      const rawN = rawV != null ? Number(rawV) : NaN;
      if (!Number.isFinite(rawN) || rawN <= 0) {
        unpricedUsd += itUsd;
        perBaseInIngUnitById.set(it.id, null);
        continue;
      }
      const storedUom = it.price_estimate?.base_uom ?? null;
      const itemDim = storedUom ? DIM_BY_UOM[normUom(storedUom) ?? ""] : undefined;
      if (itemDim) dimTally.set(itemDim, (dimTally.get(itemDim) ?? 0) + 1);
      // M2 §2.1: one price function. priceInUnit converts $/baseUom to
      // $/ingredient.base_unit through the stated-kind-wins rule.
      // Measures only fill what the case does not state.
      if (masterUom && storedUom) {
        const result = priceInUnit(
          {
            perBase: rawN,
            baseUom: storedUom,
            packQty: it.pack_qty ?? null,
            packSize: it.pack_size ?? null,
            packUom: it.pack_uom ?? null,
            caseWeightLb: it.case_weight_lb ?? null,
          },
          masterUom,
          { measures: ingMeasures },
        );
        if (result == null) {
          needsMeasureItemIds.add(it.id);
          unpricedUsd += itUsd;
          perBaseInIngUnitById.set(it.id, null);
        } else if (sizesDifferIds.has(it.id)) {
          // M2 R2 rule 2: priced, shown, NOT in the blend. Spend
          // counted as unpriced. The per-item perBaseInIngUnit is
          // computed and kept so the item row still shows its number;
          // it simply does not enter `priced`.
          unpricedUsd += itUsd;
          perBaseInIngUnitById.set(it.id, result.per);
        } else {
          priced.push({ id: it.id, v: result.per, grade: it.grade ?? null, usd: itUsd });
          vendorByPricedItem.set(it.id, it.vendor_id);
          perBaseInIngUnitById.set(it.id, result.per);
        }
      } else if (storedUom && !masterUom) {
        // Master has no canonical uom (unusual base_unit text); fall
        // back to the stored value as-is so the row still shows a
        // number.
        priced.push({ id: it.id, v: rawN, grade: it.grade ?? null, usd: itUsd });
        vendorByPricedItem.set(it.id, it.vendor_id);
        perBaseInIngUnitById.set(it.id, rawN);
      } else {
        priced.push({ id: it.id, v: rawN, grade: it.grade ?? null, usd: itUsd });
        vendorByPricedItem.set(it.id, it.vendor_id);
        perBaseInIngUnitById.set(it.id, rawN);
      }
    }
    // S3: median-based outlier exclusion. avg/min/max/spread describe
    // the survivors only; linkedItems.outlier below tags the excluded
    // rows so they still appear in the table (visibly dropped from
    // the blend, not deleted).
    //
    // G1: the "blended" stats below run over every priced item and
    // keep the pre-G1 single-price behaviour unchanged - every
    // surface that reads avgPerBase / spreadRatio / etc still sees
    // the same number. The two subset stats come from the SAME
    // blendStats (one shared code path, per the spec); they just
    // filter the input. Null is standard: anything not 'premium'
    // counts in the standard subset.
    // G2: Kevin's ruling - the lens drives every tile, not just the
    // price. When the user picks Premium, spread/min-max/pricedCount/
    // linkedCount/unpricedUsd/12-mo-spend all describe premium-only
    // items. Compute three COMPLETE stats sets, let the client swap
    // which one it reads.
    //
    // M2 §2.2: buildLensStats lives in blend.ts now and the blended
    // lens runs the outlier rule PER GRADE (Premium with Premium).
    // Standard and Premium lenses stay partition-first (byte-identical
    // to pre-M2).
    const blendItems: BlendItem[] = priced;
    const blendedLens = buildLensStats(blendItems, items, "blended");
    const standardLens = buildLensStats(blendItems, items, "standard");
    const premiumLens = buildLensStats(blendItems, items, "premium");

    // Union of per-grade exclusions for the blended lens drives the
    // row-level "outlier" flag below. Pre-M2 this was a single
    // blendStats call over every priced item; M2 runs it per grade
    // and unions the exclusion sets so a premium far from the
    // standard median is not flagged when it is in line with its
    // own grade's peers.
    const bucketExcluded = new Set<string>();
    {
      const buckets: Record<"premium" | "standard", BlendItem[]> = { premium: [], standard: [] };
      for (const p of priced) buckets[p.grade === "premium" ? "premium" : "standard"].push(p);
      for (const g of ["premium", "standard"] as const) {
        const s = blendStats(buckets[g]);
        for (const id of s.excluded) bucketExcluded.add(id);
      }
    }
    // M2: the headline numbers come from the BLENDED lens (per-grade
    // outlier, union of survivors). `excludedIds` for the row-level
    // "outlier" flag is the union across grades (bucketExcluded above).
    // `medianBeforeExclusion` keeps its pre-M2 semantics (median over
    // all priced items, used by the attention copy's "N times" label);
    // per-grade medians are an M2 refinement deferred to its own patch.
    const stats = blendStats(priced);
    const avg = blendedLens.avgPerBase;
    const min = blendedLens.minPerBase;
    const max = blendedLens.maxPerBase;
    const spread = blendedLens.spreadRatio;
    const excludedIds = bucketExcluded;
    const medianBeforeExclusion = stats.median;
    // G3 §2: Spread flag is now evaluated PER GRADE SUBSET, not across
    // the blend. A master whose only reason for a >3x blended spread
    // is the gap between standard and premium items is the grade
    // working correctly, not a pricing problem. Flag fires iff some
    // populated subset is itself >=3x internally. Single-grade masters
    // behave identically to pre-G3 - with one subset, that subset IS
    // the blend.
    //
    // Measured on production 2026-11-04: Salmon filet, Bacon sliced
    // and Chicken breast b/s clear; Beef tenderloin PSMO is unchanged
    // (2.9x lives inside Standard, under the 3x threshold, so it is
    // already unflagged and stays unflagged).
    const stdSpread = standardLens.spreadRatio;
    const premSpread = premiumLens.spreadRatio;
    const stdSpreadFlag = stdSpread != null && stdSpread > SPREAD_RATIO_MAX;
    const premSpreadFlag = premSpread != null && premSpread > SPREAD_RATIO_MAX;
    const ratioFlag = stdSpreadFlag || premSpreadFlag;
    const bandKey = masterUom;

    // B3: corroboration = two or more DISTINCT VENDORS on the
    // survivor set (same rows that produce the mean), with survivor
    // spread within the Spread threshold. Counts vendors, not vendor
    // items - this is the subtle bug the prompt names explicitly.
    // When the band would have fired on a corroborated master, the
    // Spread flag has already fired (if spread > 3) OR the vendors
    // genuinely agree (spread <= 3). Either way, population-level
    // band is the weaker signal.
    const survivorVendorIds = new Set<string>();
    for (const p of priced) {
      if (excludedIds.has(p.id)) continue;
      const vid = vendorByPricedItem.get(p.id);
      if (vid) survivorVendorIds.add(vid);
    }
    const corroboratedByVendors =
      survivorVendorIds.size >= 2 &&
      spread != null &&
      spread <= SPREAD_RATIO_MAX;

    // B3 Rule 2: count units are never banded.
    const bandAllowedByUnit = bandKey != null && !BAND_SUPPRESS_UNITS.has(bandKey);

    // N6 A2: BANDS covers LB, OZ, FLOZ, GAL, EA, DZ. A master costed in
    // a new weight or volume unit (G, KG, PT, QT, L, ML) has no row of
    // its own; convert its average into the dimension's base (LB for
    // weight, FLOZ for volume) and test against that base's band. The
    // six existing keys keep their exact numbers and their exact
    // results - the key lookup below still picks BANDS[LB] / BANDS[OZ]
    // / etc when the master is on one of those units, and convertPer
    // returns the value unchanged.
    let bandTestValue: number | null = null;
    let bandTestKey: string | null = null;
    if (avg != null && bandKey != null && bandAllowedByUnit) {
      if (BANDS[bandKey]) {
        bandTestValue = avg;
        bandTestKey = bandKey;
      } else {
        // Unit outside the BANDS set; fall through to the dimension base.
        const dim = DIM_BY_UOM[bandKey];
        if (dim === "weight" || dim === "volume") {
          const dimBase = BASE_BY_DIM[dim];
          const converted = convertPer(avg, bandKey, dimBase);
          if (converted != null && BANDS[dimBase]) {
            bandTestValue = converted;
            bandTestKey = dimBase;
          }
        }
      }
    }
    const bandFlag =
      bandAllowedByUnit &&
      !corroboratedByVendors &&
      bandTestValue != null && bandTestKey != null && BANDS[bandTestKey]
        ? bandTestValue < BANDS[bandTestKey].low || bandTestValue > BANDS[bandTestKey].high
        : false;
    const needsMeasureFlag = needsMeasureItemIds.size > 0;
    const flagged = ratioFlag || bandFlag || needsMeasureFlag;
    // G3: name which subset drove the spread flag when both grades
    // are populated; single-grade masters keep the plain copy.
    const bothGradesPopulated =
      standardLens.linkedCount > 0 && premiumLens.linkedCount > 0;
    const spreadReason = !ratioFlag
      ? null
      : !bothGradesPopulated
        ? "wide price spread"
        : stdSpreadFlag && premSpreadFlag
          ? "wide price spread in both subsets"
          : stdSpreadFlag
            ? `wide price spread (standard ${stdSpread!.toFixed(1)}x)`
            : `wide price spread (premium ${premSpread!.toFixed(1)}x)`;
    const flagReason = [
      spreadReason,
      bandFlag ? "outside typical band" : null,
      needsMeasureFlag ? `${needsMeasureItemIds.size} needs a measure` : null,
    ]
      .filter((x): x is string => x != null)
      .join(" + ") || null;

    const linkedItems: MasterLinkedItem[] = items
      .map((it) => {
        const v = it.price_estimate?.per_base;
        const n = v != null ? Number(v) : null;
        const storedUom = it.price_estimate?.base_uom ?? null;
        // M2 §2.1: price in the ingredient's base_unit comes from
        // priceInUnit, computed in the main loop above and cached
        // in perBaseInIngUnitById. When null the item needs a measure.
        const inIngUnit = perBaseInIngUnitById.get(it.id) ?? null;
        // M2 per-item status: four mutually exclusive kinds. R2
        // rule 2: sizes_differ is applied BEFORE the outlier rule so
        // an "each" meaning two things never reaches the blend math.
        const statusKind: "in_blend" | "check_it" | "needs_measure" | "sizes_differ" =
          needsMeasureItemIds.has(it.id)
            ? "needs_measure"
            : sizesDifferIds.has(it.id)
              ? "sizes_differ"
              : excludedIds.has(it.id)
                ? "check_it"
                : "in_blend";
        // M2 §2.6 chips data: which units this item's price reaches
        // through the ingredient's measures + built-in same-dim
        // conversions. Included on the row so 4B's chip switch
        // computes in the browser with no fetch.
        const reach = n != null && Number.isFinite(n) && n > 0 && storedUom
          ? Array.from(reachableUnits([storedUom], { measures: ingMeasures }))
          : [];
        return {
          id: it.id,
          name: it.name,
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          // Per-base shown in the ingredient's base_unit when reachable,
          // else the raw stored per_base with its stored uom for the
          // linked-items table's dim-mismatch note.
          perBase:
            inIngUnit != null
              ? inIngUnit
              : n != null && Number.isFinite(n) && n > 0
                ? n
                : null,
          perBaseUom: inIngUnit != null ? masterUom : storedUom,
          statusKind,
          perBaseInIngUnit: inIngUnit,
          reach,
          // S3: outlier means EXCLUDED by the median-based rule. True
          // only when >=3 priced items in-dim exist AND this item's
          // converted per-base is >3x median or <median/3. Under 3
          // items this stays false (there is no median to be an
          // outlier against).
          outlier: excludedIds.has(it.id),
          // S3: hand-set price survives the backfill and still gets
          // outlier-checked by this rule. The chip surfaces it so
          // Kevin knows the fix is the override, not the parser.
          priceManualOverride: isPriceManualOverride(it.pack_override),
          // G1: carry the item's stored grade so the linked-items
          // table in the master detail pane can label the tier.
          // Null is standard; see src/lib/ingredients/grade.ts.
          grade: it.grade ?? null,
          usd12m: Number(it.usd_12m ?? 0),
          // M1 R3 fix 2: case_weight_lb is the source of truth for
          // whether the item has an override; the legacy pair controls
          // DISPLAY shape when it agrees. Pre-0019 we keep the legacy
          // shape unchanged.
          eachMeasure: measuresWorld
            ? shapeItemEachFromCaseWeight(
                it.case_weight_lb ?? null,
                it.pack_qty ?? null,
                it.pack_size ?? null,
                it.pack_uom ?? null,
                it.each_measure_qty,
                it.each_measure_uom,
              )
            : it.each_measure_qty != null && it.each_measure_uom
              ? { qty: Number(it.each_measure_qty), uom: it.each_measure_uom }
              : null,
        };
      })
      .sort((a, b) => b.usd12m - a.usd12m);

    // When most of a master's priced items are in a dimension the
    // master itself is not, the master is the odd one out - almost
    // always because it was created on the hardcoded 'each' default
    // while its items are billed by weight. Suggest the unit its own
    // items agree on. A majority vote, not a fact: the control offers
    // it, the human applies it. Null when the master already agrees,
    // when there are no priced items, or when it is a tie.
    const masterDim = masterUom ? DIM_BY_UOM[masterUom] : undefined;
    let suggestedBaseUnit: string | null = null;
    if (masterDim) {
      let topDim: string | null = null;
      let topN = 0;
      let tied = false;
      for (const [d, n] of dimTally) {
        if (n > topN) { topDim = d; topN = n; tied = false; }
        else if (n === topN) { tied = true; }
      }
      if (topDim && !tied && topDim !== masterDim && topN > (dimTally.get(masterDim) ?? 0)) {
        suggestedBaseUnit =
          topDim === "weight" ? "lb" : topDim === "volume" ? "gal" : topDim === "count" ? "each" : null;
      }
    }

    // Typed issues, ordered most-actionable first. `flagged` and
    // `flagReason` above keep their exact previous meaning for anything
    // still reading them; this is a parallel, richer signal.
    // S3: pricedCount describes items that CONTRIBUTE to the headline
    // price. Outliers are excluded here too so "N of M in this price"
    // tells the truth: the Vidalat case was 1 of 10 priced; after
    // outlier exclusion it would be 1 of 1, which is correct - the
    // other 9 blended, this one didn't.
    const pricedCount = priced.length - excludedIds.size;
    // B4: empty = zero LIVE vendor items under this master. The
    // server query above already filters on LIVE_STATUSES, so
    // items.length == 0 means "no active + no resale items" -
    // archived / not_food / duplicate / one_off don't count as
    // live. This can't be costed and is almost always ready to
    // retire; it counts toward Needs attention via the issues
    // array below.
    const emptyFlag = items.length === 0;
    const issues: MasterIssue[] = [
      // G3: subset-aware. Same threshold (3x), evaluated per populated
      // grade. Three masters (Salmon filet, Bacon sliced, Chicken
      // breast b/s) lose this flag because their >3x was the grade
      // split, not internal.
      ratioFlag ? ("spread" as const) : null,
      pricedCount < items.length ? ("coverage" as const) : null,
      needsMeasureItemIds.size > 0 ? ("needs_measure" as const) : null,
      sizesDifferIds.size > 0 ? ("sizes_differ" as const) : null,
      linkedItems.some((li) => li.outlier) ? ("outlier" as const) : null,
      bandFlag ? ("band" as const) : null,
      emptyFlag ? ("empty" as const) : null,
    ].filter((x): x is MasterIssue => x != null);

    return {
      id: m.id,
      name: m.name,
      parent: m.parent,
      category: m.category,
      baseUnit: m.base_unit,
      resale: m.resale,
      // B1 (allergens): three-state values pass through verbatim.
      // Row-level marker + filter chip + count derive from
      // allergensReviewedAt == null.
      allergens: m.allergens,
      allergensReviewedBy: m.allergens_reviewed_by,
      allergensReviewedAt: m.allergens_reviewed_at,
      linkedCount: items.length,
      usd12m: usd,
      avgPerBase: avg,
      minPerBase: min,
      maxPerBase: max,
      spreadRatio: spread,
      pricedCount,
      // G2: full per-lens stats. The client swaps which lens populates
      // ALL FOUR tiles - price, spread, in-this-price, 12-mo spend -
      // per Kevin's §4 correction. The flat avgPerBase/min/max/spread/
      // pricedCount/linkedCount/unpricedUsd/usd12m fields above stay
      // as the blended values for the list-row's existing readers;
      // detail-pane tiles read statsByLens[lens] instead.
      statsByLens: {
        blended: blendedLens,
        standard: standardLens,
        premium: premiumLens,
      },
      unpricedUsd,
      issues,
      suggestedBaseUnit,
      // S3: pre-exclusion median used by the "N items excluded as
      // outliers" note. Null when no priced items in the master's
      // dimension.
      medianBeforeExclusion,
      // Display + band lookup use the master's canonical uom so Milk
      // reads "$/gal" (not "$/floz"), Bottled water reads "$/each", etc.
      baseUom: masterUom,
      flagged,
      flagReason,
      linkedItems,
      // N6: the master's own each measure + where it came from. Snake
      // field names on the fetch row get projected to camel here so
      // the client type stays camel-only. Null when unknown.
      eachMeasureQty: m.each_measure_qty == null ? null : Number(m.each_measure_qty),
      eachMeasureUom: m.each_measure_uom ?? null,
      eachMeasureSource: m.each_measure_source ?? null,
      // M2 §3.7 amendment 1: measures + yield ride on MasterRow so the
      // Ingredients tab's PanelIngredientZone mount reads them without
      // a per-row fetch.
      measures: ingMeasures.map((x) => ({
        from_unit: x.from_unit,
        qty: x.qty,
        to_unit: x.to_unit,
        source: x.source,
      })),
      yieldPct: (m as { yield_pct?: number | null }).yield_pct ?? null,
      yieldSource: (m as { yield_source?: string | null }).yield_source ?? null,
    };
  });

  // Totals (headline).
  const totalMasters = rows.length;
  const totalLinked = rows.reduce((s, r) => s + r.linkedCount, 0);
  const totalUsd = rows.reduce((s, r) => s + r.usd12m, 0);
  // Counts any master carrying at least one typed issue. This is a
  // SUPERSET of the old `flagged` boolean because coverage and outlier
  // are now counted - masters whose headline price is computed on a
  // subset of their links were previously invisible here. Expect this
  // number to rise; that is the point.
  const totalFlagged = rows.filter((r) => r.issues.length > 0).length;

  // R2: hero + Tabs vary by mode. Recipe mode keeps the four-cell
  // layout; Resale drops the Needs-attention cell per the Oct 31
  // ruling (resale is outside recipe coverage / attention math).
  // Every number is live over the pre-filtered master set.
  const heroFacts =
    mode === "resale"
      ? [
          { label: "Retail masters", value: fmtCount(totalMasters), note: "sold as-is, not cooked" },
          { label: "Linked items", value: fmtCount(totalLinked), note: "confirmed to a master" },
          { label: "12-mo spend", value: fmtUsd(totalUsd), note: "outside recipe coverage" },
        ]
      : [
          { label: "Masters", value: fmtCount(totalMasters), note: "active ingredients" },
          { label: "Linked items", value: fmtCount(totalLinked), note: "confirmed to a master" },
          { label: "Linked spend", value: fmtUsd(totalUsd), note: "12 months" },
          { label: "Needs attention", value: fmtCount(totalFlagged), note: "spread, unit or outlier" },
        ];

  return (
    <div className="kf-ing">
      <IdentBand
        eyebrow="Culinary office"
        title={mode === "resale" ? "Retail" : "Ingredients"}
        facts={heroFacts}
      />

      <Tabs active={mode === "resale" ? "retail" : "ingredients"} />

      <IngredientMastersFilter rows={rows} mode={mode} />
    </div>
  );
}
