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
// already-aggregated server data. Native <details> on each row for
// inline drill-in (saves a round-trip; no new drawer surface).

import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import {
  IngredientMastersFilter,
  type MasterRow,
  type MasterLinkedItem,
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
};

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

// Convert a `pricePerStoredUom` value (what the backfill wrote into
// `price_estimate.per_base`, labeled by `storedUom`) into the master's
// `targetUom`. Returns null when the two uoms are from different
// dimensions (unit mismatch - a strong "bad pack" signal). The master
// is the source of truth; the stored base_uom came out of a pack
// parse that doesn't know about the ingredient's natural unit.
const FACTORS: Record<string, number> = {
  // weight (base LB)
  LB: 1,
  OZ: 1 / 16,
  G: 1 / 453.592,
  KG: 2.20462,
  // volume (base FLOZ)
  FLOZ: 1,
  L: 33.814,
  ML: 0.033814,
  GAL: 128,
  QT: 32,
  PT: 16,
  // count (base EA)
  EA: 1,
  DZ: 12,
  CT: 1,
  PC: 1,
};
const DIM: Record<string, "weight" | "volume" | "count"> = {
  LB: "weight", OZ: "weight", G: "weight", KG: "weight",
  FLOZ: "volume", L: "volume", ML: "volume", GAL: "volume", QT: "volume", PT: "volume",
  EA: "count", DZ: "count", CT: "count", PC: "count",
};

function convertPer(
  value: number,
  storedUom: string | null | undefined,
  targetUom: string | null | undefined
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (!storedUom || !targetUom) return null;
  const su = storedUom.toUpperCase();
  const tu = targetUom.toUpperCase();
  if (su === tu) return value;
  const sf = FACTORS[su];
  const tf = FACTORS[tu];
  if (sf == null || tf == null) return null;
  if (DIM[su] !== DIM[tu]) return null; // different dimensions - mismatch
  // $/A = value; convert so we're expressing $/target.
  //   per-$-per-target = value * (tf / sf)
  return value * (tf / sf);
}

// Normalize the master's base_unit text ('lb', 'each', 'gal', 'dozen',
// anything the schema allows) to one of our canonical uoms so BANDS +
// convertPer can key by it.
function canonicalFromBaseUnit(baseUnit: string | null): string | null {
  if (!baseUnit) return null;
  const u = baseUnit.toUpperCase().trim();
  if (u === "LB" || u === "LBS" || u === "POUND" || u === "POUNDS") return "LB";
  if (u === "OZ") return "OZ";
  if (u === "G" || u === "GRAM") return "G";
  if (u === "KG") return "KG";
  if (u === "FLOZ" || u === "FL OZ") return "FLOZ";
  if (u === "L" || u === "LITER" || u === "LTR") return "L";
  if (u === "ML") return "ML";
  if (u === "GAL" || u === "GALLON") return "GAL";
  if (u === "QT" || u === "QUART") return "QT";
  if (u === "PT" || u === "PINT") return "PT";
  if (u === "EA" || u === "EACH") return "EA";
  if (u === "DZ" || u === "DOZ" || u === "DZN" || u === "DOZEN") return "DZ";
  if (u === "CT" || u === "COUNT") return "CT";
  if (u === "PC" || u === "PIECE") return "PC";
  return null;
}

export async function IngredientMasters() {
  const client = serviceClient();

  // Masters.
  const { data: ingData, error: ingErr } = await client
    .from("pr_ingredients")
    .select("id,name,parent,category,resale,base_unit")
    .eq("status", "active")
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
      .select("id,vendor_id,ingredient_id,name,usd_12m,price_estimate")
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
    const perBaseValues: number[] = [];
    const mismatchedItemIds = new Set<string>();
    let usd = 0;
    for (const it of items) {
      usd += Number(it.usd_12m ?? 0);
      const rawV = it.price_estimate?.per_base;
      const rawN = rawV != null ? Number(rawV) : NaN;
      if (!Number.isFinite(rawN) || rawN <= 0) continue;
      const storedUom = it.price_estimate?.base_uom ?? null;
      if (masterUom && storedUom) {
        const converted = convertPer(rawN, storedUom, masterUom);
        if (converted == null) {
          mismatchedItemIds.add(it.id);
          // Keep the raw number out of the aggregate so the avg isn't
          // polluted by cross-dimension values; the mismatch flag
          // handles the surface.
        } else {
          perBaseValues.push(converted);
        }
      } else if (storedUom && !masterUom) {
        // Master has no canonical uom (unusual base_unit text); fall
        // back to the stored value as-is so the row still shows a
        // number.
        perBaseValues.push(rawN);
      } else {
        perBaseValues.push(rawN);
      }
    }
    const avg =
      perBaseValues.length > 0
        ? perBaseValues.reduce((s, x) => s + x, 0) / perBaseValues.length
        : null;
    const min = perBaseValues.length > 0 ? Math.min(...perBaseValues) : null;
    const max = perBaseValues.length > 0 ? Math.max(...perBaseValues) : null;
    const spread = min != null && max != null && min > 0 ? max / min : null;
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
          usd12m: Number(it.usd_12m ?? 0),
        };
      })
      .sort((a, b) => b.usd12m - a.usd12m);

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
  const totalFlagged = rows.filter((r) => r.flagged).length;

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office</span>
        <h2>Ingredients</h2>
        <p className="kf-ing__kicker">
          The master list, building as the review progresses. Each row is one named
          ingredient; the per-unit column blends every linked vendor item&rsquo;s
          <code>price_estimate.per_base</code>. Rows with a wide spread or an out-of-band
          average are flagged - that&rsquo;s usually a bad pack hiding on one of the linked
          items.
        </p>
      </header>

      <Tabs active="ingredients" />

      <section className="kf-review__meta" aria-label="Master-list totals">
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Masters</span>
          <strong>{fmtCount(totalMasters)}</strong>
          <span className="kf-review__meta-sub">active ingredients</span>
        </div>
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Linked vendor items</span>
          <strong>{fmtCount(totalLinked)}</strong>
          <span className="kf-review__meta-sub">confirmed to a master</span>
        </div>
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Linked spend</span>
          <strong>{fmtUsd(totalUsd)}</strong>
          <span className="kf-review__meta-sub">12 months, from linked items</span>
        </div>
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Flagged (bad-pack radar)</span>
          <strong>{fmtCount(totalFlagged)}</strong>
          <span className="kf-review__meta-sub">
            spread &gt; 3x OR avg outside typical band
          </span>
        </div>
      </section>

      <IngredientMastersFilter rows={rows} />
    </div>
  );
}
