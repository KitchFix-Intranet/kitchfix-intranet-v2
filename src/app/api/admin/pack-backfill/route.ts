import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { estimatePerUnit } from "@/lib/ingredients/estimate";
import { DIM_BY_UOM, TO_BASE, normUom } from "@/lib/ingredients/pack";

export const dynamic = "force-dynamic";

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
    const emptyCounts = { ok: 0, check: 0, none: 0, skipped: 0, nameMatched: 0 };
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

  // Phase 1.9 name-match fallback catalog load (unchanged from prior).
  const nameMap = new Map<
    string,
    { packSet: Set<string>; best: NameCatalogRow | null }
  >();
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
        for (const r of rows) {
          const nn = normalizeName(r.clean_name);
          if (!nn) continue;
          const packN = normalizePackText(r.pack_text);
          const key = `${vendorId}#${nn}`;
          let entry = nameMap.get(key);
          if (!entry) {
            entry = { packSet: new Set<string>(), best: null };
            nameMap.set(key, entry);
          }
          entry.packSet.add(packN);
          const price =
            r.catalog_price != null ? Number(r.catalog_price) : NaN;
          const hasPrice = Number.isFinite(price) && price > 0;
          if (!entry.best) {
            entry.best = r;
          } else {
            const bestPrice =
              entry.best.catalog_price != null ? Number(entry.best.catalog_price) : NaN;
            const bestHasPrice = Number.isFinite(bestPrice) && bestPrice > 0;
            if (hasPrice && !bestHasPrice) entry.best = r;
          }
        }
        if (rows.length < page) break;
        from += page;
      }
    }
  }

  // Prompt B: aggregate pr_price_observations into one Actuals record
  // per batch item. latest_unit_price keeps its "newest invoice_date
  // wins" semantics; sum_extended / sum_quantity / sum_weight are the
  // new blended inputs. unit_consistent is false when the lines mix
  // billed units (then quantity-derived tiers are skipped).
  const actualsByItem = new Map<string, Actuals>();
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
      const { data: obsData, error: obsErr } = await client
        .from("pr_price_observations")
        .select(
          "vendor_item_id,unit_price,invoice_date,quantity,extended_price,billed_unit,weight_line_value"
        )
        .in("vendor_item_id", ids)
        .is("excluded_reason", null)
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
        const qty = Number(o.quantity ?? 0);
        const wt = Number(o.weight_line_value ?? 0);
        const up = Number(o.unit_price ?? 0);
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
        const isColumnCopy =
          Number.isFinite(qty) &&
          Number.isFinite(ext) &&
          ext > 2 &&
          Math.abs(qty - ext) < 0.01;

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
  const counts = { ok: 0, check: 0, none: 0, skipped: 0, nameMatched: 0 };
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

    if (!cat) {
      const nn = normalizeName(it.name);
      if (nn.length > 0) {
        const nameKey = `${it.vendor_id}#${nn}`;
        const entry = nameMap.get(nameKey);
        if (entry && entry.packSet.size === 1 && entry.best) {
          cat = {
            pack_text: entry.best.pack_text,
            catalog_price: entry.best.catalog_price,
          };
          matchSource = "catalog_name";
        }
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
    };
    if (matchSource) {
      estimate.match_source = matchSource;
      if (matchSource === "catalog_name") {
        const nameNote = "matched to catalog by name (invoice SKU/pack missing); verify";
        estimate.note = baseEstimate.note ? `${baseEstimate.note}; ${nameNote}` : nameNote;
      }
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
    let packState: "ok" | "check" | "none" =
      matchSource === "catalog_name"
        ? "check"
        : derivedPackUsed
          ? "check"
          : effectiveConf === "high"
            ? "ok"
            : effectiveConf === "low"
              ? "check"
              : "none";

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
          const blend =
            others.reduce((s, x) => s + (x.perBase as number), 0) / others.length;
          if (Number.isFinite(blend) && blend > 0) {
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
      continue;
    }

    const updatePayload: Record<string, unknown> = {
      pack_qty: packQtyOut,
      pack_size: packSizeOut,
      pack_uom: packUomOut,
      pack_state: packState,
      price_estimate: estimate,
    };
    if (derivedPackLb != null) {
      // pack_note is a free-text annotation on pr_vendor_items; harmless
      // to overwrite with each run (same inputs -> same note).
      updatePayload.pack_note = packNote;
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

  const response: Record<string, unknown> = {
    ok: true,
    done,
    dryRun,
    processed: items.length,
    nextOffset: offset + items.length,
    counts,
    nameMatched: counts.nameMatched,
  };
  if (dryRun) {
    response.dryRunSummary = {
      packStateTransitions,
      gainedPerBase,
      lostPerBase,
      bySource,
      derivedPacks,
      tierBRejectedByBounds,
      wouldBeFlags,
      topChanges,
    };
  }
  return NextResponse.json(response);
}
