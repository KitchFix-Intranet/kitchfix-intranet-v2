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
};

// S3: median-based outlier exclusion for the master blend. Rule:
// with 3+ priced items, any item >3x median or <median/3 is excluded;
// the master's price/spread are mean/min/max of the survivors. Under
// 3 items there is nothing to be a median of; include everything.
//
// Applied identically here (render blend) and in
// pack-backfill/route.ts (per-item cross-check). The duplication is
// ~20 lines each with the same constants; if a third site appears,
// extract to a shared module. The constants are the one authoritative
// place for the thresholds.
const OUTLIER_RATIO = 3;
const OUTLIER_MIN = 3;

function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

// G2: `survivorMean` is now SPEND-WEIGHTED: sum(per_base * usd_12m) /
// sum(usd_12m) over the survivors. Pre-G2 this was a plain mean, which
// let a small-spend item count as much as a high-spend one. The recipe
// cost that reads this field is the operational reason: weighting
// makes the headline match the dollars actually spent.
//
// Outlier exclusion is UNCHANGED - median of raw per_base values,
// items >3x or <1/3 of median drop out. The rule still protects the
// mean from a very-low or very-high outlier; weighting only shrinks
// what the remaining outliers do to the number.
//
// `survivorMin` and `survivorMax` remain plain (unweighted) over the
// survivor set. They describe the range of prices, not the blended
// cost - per Kevin's §2.3 ruling, spread/min/max are not weighted
// even when the lens is on.
//
// Fallback: if the survivor set's total usd is 0 or null, fall back
// to the plain mean. One priced item or a zero-spend subset cannot
// be weighted; must not divide by zero and must never render NaN.
function blendStats(priced: ReadonlyArray<{ id: string; v: number; usd: number }>): {
  median: number | null;
  survivorMean: number | null;
  survivorMin: number | null;
  survivorMax: number | null;
  excluded: Set<string>;
} {
  if (priced.length === 0) {
    return { median: null, survivorMean: null, survivorMin: null, survivorMax: null, excluded: new Set() };
  }
  const vals = priced.map((p) => p.v);
  const med = medianOf(vals);
  const weighted = (xs: ReadonlyArray<{ v: number; usd: number }>): number | null => {
    if (xs.length === 0) return null;
    let num = 0;
    let den = 0;
    for (const x of xs) {
      const u = Number.isFinite(x.usd) && x.usd > 0 ? x.usd : 0;
      num += x.v * u;
      den += u;
    }
    if (den > 0) return num / den;
    // Zero/null-spend fallback: plain mean so the lens still shows a
    // number instead of "-" when every item has non-positive usd.
    const sum = xs.reduce((a, b) => a + b.v, 0);
    return sum / xs.length;
  };
  if (priced.length < OUTLIER_MIN) {
    return {
      median: med,
      survivorMean: weighted(priced),
      survivorMin: Math.min(...vals),
      survivorMax: Math.max(...vals),
      excluded: new Set(),
    };
  }
  const low = med / OUTLIER_RATIO;
  const high = med * OUTLIER_RATIO;
  const excluded = new Set<string>();
  const survivors: Array<{ v: number; usd: number }> = [];
  for (const p of priced) {
    if (p.v > high || p.v < low) excluded.add(p.id);
    else survivors.push({ v: p.v, usd: p.usd });
  }
  if (survivors.length === 0) {
    return { median: med, survivorMean: null, survivorMin: null, survivorMax: null, excluded };
  }
  const svals = survivors.map((s) => s.v);
  return {
    median: med,
    survivorMean: weighted(survivors),
    survivorMin: Math.min(...svals),
    survivorMax: Math.max(...svals),
    excluded,
  };
}

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
import { DIM_BY_UOM, normUom, convertPer, canonicalFromBaseUnit } from "@/lib/ingredients/pack";
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
    .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at")
    .eq("status", "active")
    .eq("resale", mode === "resale")
    .order("name");
  if (ingErr) throw ingErr;
  const ingredients = (ingData ?? []) as Ingredient[];

  // Confirmed vendor items (paginated at 1000 - PostgREST db-max-rows cap).
  const linked: LinkedItemRow[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select("id,vendor_id,ingredient_id,name,usd_12m,price_estimate,pack_override,grade")
      .eq("link_status", "confirmed")
      .in("status", LIVE_STATUSES) // B4: archived/not_food/duplicate/one_off never reach the rollup
      .not("ingredient_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    const chunk = (data ?? []) as LinkedItemRow[];
    linked.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }

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
    const mismatchedItemIds = new Set<string>();
    let usd = 0;
    // Spend on items that contribute NOTHING to the master's price -
    // either no usable per_base at all, or a cross-dimension value we
    // refuse to average. This is the money the headline $/unit does
    // not describe. (S3 does NOT re-classify outliers as "unpriced":
    // their spend IS covered by a confirmed link; the blend just
    // leaves them out of its own math.)
    let unpricedUsd = 0;
    // How many priced items sit in each dimension, regardless of
    // whether they converted. Used ONLY to suggest a base_unit when the
    // master's own unit is the odd one out; it never touches the blend.
    const dimTally = new Map<string, number>();
    for (const it of items) {
      const itUsd = Number(it.usd_12m ?? 0);
      usd += itUsd;
      const rawV = it.price_estimate?.per_base;
      const rawN = rawV != null ? Number(rawV) : NaN;
      if (!Number.isFinite(rawN) || rawN <= 0) {
        unpricedUsd += itUsd;
        continue;
      }
      const storedUom = it.price_estimate?.base_uom ?? null;
      const itemDim = storedUom ? DIM_BY_UOM[normUom(storedUom) ?? ""] : undefined;
      if (itemDim) dimTally.set(itemDim, (dimTally.get(itemDim) ?? 0) + 1);
      if (masterUom && storedUom) {
        const converted = convertPer(rawN, storedUom, masterUom);
        if (converted == null) {
          mismatchedItemIds.add(it.id);
          unpricedUsd += itUsd;
          // Keep the raw number out of the aggregate so the avg isn't
          // polluted by cross-dimension values; the mismatch flag
          // handles the surface.
        } else {
          priced.push({ id: it.id, v: converted, grade: it.grade ?? null, usd: itUsd });
          vendorByPricedItem.set(it.id, it.vendor_id);
        }
      } else if (storedUom && !masterUom) {
        // Master has no canonical uom (unusual base_unit text); fall
        // back to the stored value as-is so the row still shows a
        // number.
        priced.push({ id: it.id, v: rawN, grade: it.grade ?? null, usd: itUsd });
        vendorByPricedItem.set(it.id, it.vendor_id);
      } else {
        priced.push({ id: it.id, v: rawN, grade: it.grade ?? null, usd: itUsd });
        vendorByPricedItem.set(it.id, it.vendor_id);
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
    // Each buildLensStats call:
    //   - re-runs blendStats on its subset (outlier exclusion is
    //     per-subset; an item that's an outlier in the combined set
    //     may not be one within Standard alone, and vice versa)
    //   - counts linkedCount on the same grade partition of `items`
    //     (the raw unfiltered list, so even un-priced items count)
    //   - splits unpricedUsd by grade so each lens's "in this price"
    //     tells the truth about its own population.
    // Grade predicate is just "standard" vs "premium" vs "both". Null
    // counts as standard; anything else is treated as standard too per
    // the UI rule (any stray third value falls into the standard bucket).
    const inSubset = (g: string | null, lens: "blended" | "standard" | "premium"): boolean => {
      if (lens === "blended") return true;
      const t = g === "premium" ? "premium" : "standard";
      return t === lens;
    };
    const pricedIdSet = new Set(priced.map((p) => p.id));
    const buildLensStats = (lens: "blended" | "standard" | "premium"): LensStats => {
      const subsetPriced = priced.filter((p) => inSubset(p.grade, lens));
      const s = blendStats(subsetPriced);
      const min = s.survivorMin;
      const max = s.survivorMax;
      const spread = min != null && max != null && min > 0 ? max / min : null;
      let linkedCount = 0;
      let subsetUsd = 0;
      let subsetUnpricedUsd = 0;
      for (const it of items) {
        if (!inSubset(it.grade ?? null, lens)) continue;
        linkedCount += 1;
        const itU = Number(it.usd_12m ?? 0);
        subsetUsd += itU;
        // An item is "priced into" its subset if it contributed to the
        // subset's blend - priced AND not excluded as an outlier of
        // THIS subset's median.
        if (!pricedIdSet.has(it.id) || s.excluded.has(it.id)) subsetUnpricedUsd += itU;
      }
      const pricedCount = subsetPriced.length - s.excluded.size;
      return {
        avgPerBase: s.survivorMean,
        minPerBase: min,
        maxPerBase: max,
        spreadRatio: spread,
        pricedCount,
        linkedCount,
        usd12m: subsetUsd,
        unpricedUsd: subsetUnpricedUsd,
      };
    };

    const blendedLens = buildLensStats("blended");
    const standardLens = buildLensStats("standard");
    const premiumLens = buildLensStats("premium");

    // The "blended" stats stay the source of truth for the LIST row
    // and for the attention logic below. Every pre-G1 reader of
    // avgPerBase/spreadRatio/min/max/pricedCount/linkedCount/
    // unpricedUsd/usd12m keeps the same number (spend-weighted now,
    // but the field it reads is unchanged).
    const stats = blendStats(priced);
    const avg = stats.survivorMean;
    const min = stats.survivorMin;
    const max = stats.survivorMax;
    const spread = min != null && max != null && min > 0 ? max / min : null;
    const excludedIds = stats.excluded;
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

    const bandFlag =
      bandAllowedByUnit &&
      !corroboratedByVendors &&
      avg != null && bandKey != null && BANDS[bandKey]
        ? avg < BANDS[bandKey].low || avg > BANDS[bandKey].high
        : false;
    const mismatchFlag = mismatchedItemIds.size > 0;
    const flagged = ratioFlag || bandFlag || mismatchFlag;
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
      mismatchFlag ? `${mismatchedItemIds.size} unit mismatch${mismatchedItemIds.size === 1 ? "" : "es"}` : null,
    ]
      .filter((x): x is string => x != null)
      .join(" + ") || null;

    const linkedItems: MasterLinkedItem[] = items
      .map((it) => {
        const v = it.price_estimate?.per_base;
        const n = v != null ? Number(v) : null;
        const storedUom = it.price_estimate?.base_uom ?? null;
        const normalized =
          n != null && Number.isFinite(n) && n > 0 && masterUom && storedUom
            ? convertPer(n, storedUom, masterUom)
            : null;
        return {
          id: it.id,
          name: it.name,
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          // The row shows the normalized value (same unit as the
          // master); when conversion fails the raw value shows with
          // its stored uom + a unit-mismatch note.
          perBase:
            normalized != null
              ? normalized
              : n != null && Number.isFinite(n) && n > 0
                ? n
                : null,
          perBaseUom: normalized != null ? masterUom : storedUom,
          unitMismatch: mismatchedItemIds.has(it.id),
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
      mismatchedItemIds.size > 0 ? ("mismatch" as const) : null,
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
