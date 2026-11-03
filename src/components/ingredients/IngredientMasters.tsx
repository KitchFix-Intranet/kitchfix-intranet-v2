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

function blendStats(priced: ReadonlyArray<{ id: string; v: number }>): {
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
  if (priced.length < OUTLIER_MIN) {
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      median: med,
      survivorMean: sum / vals.length,
      survivorMin: Math.min(...vals),
      survivorMax: Math.max(...vals),
      excluded: new Set(),
    };
  }
  const low = med / OUTLIER_RATIO;
  const high = med * OUTLIER_RATIO;
  const excluded = new Set<string>();
  const survivors: number[] = [];
  for (const p of priced) {
    if (p.v > high || p.v < low) excluded.add(p.id);
    else survivors.push(p.v);
  }
  if (survivors.length === 0) {
    return { median: med, survivorMean: null, survivorMin: null, survivorMax: null, excluded };
  }
  const sum = survivors.reduce((a, b) => a + b, 0);
  return {
    median: med,
    survivorMean: sum / survivors.length,
    survivorMin: Math.min(...survivors),
    survivorMax: Math.max(...survivors),
    excluded,
  };
}

type VendorRow = { id: string; name: string };

// Sane $/base bands used to catch outliers that single-link items
// miss by the spread rule. Loose bounds; a hit is a soft "look here",
// not a hard assertion. Keyed by the MASTER's base_unit (the source
// of truth), after we convert the per-base values to that unit.
const BANDS: Record<string, { low: number; high: number }> = {
  LB: { low: 0.5, high: 100 },
  OZ: { low: 0.03, high: 6 },
  FLOZ: { low: 0.01, high: 5 },
  GAL: { low: 1, high: 200 },
  EA: { low: 0.1, high: 25 },
  DZ: { low: 1, high: 60 },
};

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
    .select("id,name,parent,category,resale,base_unit")
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
      .select("id,vendor_id,ingredient_id,name,usd_12m,price_estimate,pack_override")
      .eq("link_status", "confirmed")
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
    const priced: Array<{ id: string; v: number }> = [];
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
          priced.push({ id: it.id, v: converted });
        }
      } else if (storedUom && !masterUom) {
        // Master has no canonical uom (unusual base_unit text); fall
        // back to the stored value as-is so the row still shows a
        // number.
        priced.push({ id: it.id, v: rawN });
      } else {
        priced.push({ id: it.id, v: rawN });
      }
    }
    // S3: median-based outlier exclusion. avg/min/max/spread describe
    // the survivors only; linkedItems.outlier below tags the excluded
    // rows so they still appear in the table (visibly dropped from
    // the blend, not deleted).
    const stats = blendStats(priced);
    const avg = stats.survivorMean;
    const min = stats.survivorMin;
    const max = stats.survivorMax;
    const spread = min != null && max != null && min > 0 ? max / min : null;
    const excludedIds = stats.excluded;
    const medianBeforeExclusion = stats.median;
    const ratioFlag = spread != null && spread > 3;
    const bandKey = masterUom;
    const bandFlag =
      avg != null && bandKey != null && BANDS[bandKey]
        ? avg < BANDS[bandKey].low || avg > BANDS[bandKey].high
        : false;
    const mismatchFlag = mismatchedItemIds.size > 0;
    const flagged = ratioFlag || bandFlag || mismatchFlag;
    const flagReason = [
      ratioFlag ? "wide price spread" : null,
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
    const issues: MasterIssue[] = [
      spread != null && spread > 3 ? ("spread" as const) : null,
      pricedCount < items.length ? ("coverage" as const) : null,
      mismatchedItemIds.size > 0 ? ("mismatch" as const) : null,
      linkedItems.some((li) => li.outlier) ? ("outlier" as const) : null,
      bandFlag ? ("band" as const) : null,
    ].filter((x): x is MasterIssue => x != null);

    return {
      id: m.id,
      name: m.name,
      parent: m.parent,
      category: m.category,
      baseUnit: m.base_unit,
      resale: m.resale,
      linkedCount: items.length,
      usd12m: usd,
      avgPerBase: avg,
      minPerBase: min,
      maxPerBase: max,
      spreadRatio: spread,
      pricedCount,
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
          { label: "Resale masters", value: fmtCount(totalMasters), note: "sold as-is, not cooked" },
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
        title={mode === "resale" ? "Resale" : "Ingredients"}
        facts={heroFacts}
      />

      <Tabs active={mode === "resale" ? "resale" : "ingredients"} />

      <IngredientMastersFilter rows={rows} mode={mode} />
    </div>
  );
}
