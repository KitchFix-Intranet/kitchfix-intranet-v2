// Review queue - the human side of step 5. Server component: loads every
// proposed-food item + its matcher reason + its ingredient target (or
// ai-new proposed name), groups by target, sorts groups by total 12m
// dollars descending, renders. The actions UI is a separate client island
// (ReviewActions).

import { serviceClient } from "@/lib/supabase/service";
import { COUNTABLE_OBSERVATIONS_VIEW, applyCountableFilter } from "@/lib/ingredients/countability";
import { categoryForParent } from "@/lib/ingredients/categories";
import { isMeasuresWorld, readAllMeasures } from "@/lib/ingredients/measuresRead";
import { shapeIngredientEachFromMeasures, shapeItemEachFromCaseWeight } from "@/lib/ingredients/measuresShape";
import { priceInUnit } from "@/lib/ingredients/measures";
import { canonicalFromBaseUnit } from "@/lib/ingredients/pack";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import { IdentBand } from "@/components/ui/IdentBand";
import { ReviewCard, type ReviewCardGroup } from "./ReviewCard";
import { isPackManualOverride, isPriceManualOverride } from "./itemTypes";
import { ReviewLedger } from "./ReviewLedger";
import { ReviewFilter, type ReviewFilterGroup } from "./ReviewFilter";
import "./ingredients.css";
import "./review.css";
// Pulled in so the search field inherits the shared .kf-field--search
// token set from Vendor-items / Ingredients (magnifier, Enter / clear
// pill). Keeps the input visually native across tabs.
import "./table.css";

type ProposedItem = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  description_key: string;
  pack_text: string | null;
  pack_qty: number | null;
  pack_size: number | null;
  pack_uom: string | null;
  pack_state: string;
  pack_override: unknown;
  pack_note: string | null;
  billed_unit: string | null;
  catch_weight: boolean;
  ingredient_id: string | null;
  link_confidence: string | null;
  link_reason: string | null;
  usd_12m: number | null;
  lines_12m: number | null;
  accounts: string[] | null;
  last_seen: string | null;
  flagged: boolean | null;
  flag_note: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  price_estimate: {
    per_base?: number | null;
    base_uom?: string | null;
    case_price?: number | null;
    case_price_source?: string | null;
    pack_source?: string | null;
    // P1 §5: how the catalog row (if any) was matched. 'sku' is exact
    // key match; 'catalog_name' is trigram-fuzzy name match (score
    // carried in match_score for the panel's tooltip). The panel's
    // ItemFacts reads BOTH pack_source and match_source to label the
    // row (e.g. "from catalog (name match)").
    match_source?: string | null;
    match_score?: number | null;
    confidence?: string | null;
    note?: string | null;
  } | null;
  grade: string | null;
  // N5: the item's own each weight, when its each is a different size
  // than the ingredient's average. Null for most rows.
  // N6: the item's own each measure override. Nulls for most rows.
  each_measure_qty: number | null;
  each_measure_uom: string | null;
  // M1 R2 fix 1: optional so the SELECT can omit it pre-0019.
  case_weight_lb?: number | null;
};

type Ingredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
  base_unit: string;
  // B1: allergen three-state fields flow through this type so the
  // detail panel's IngredientBlock reads them when opened from the
  // Review queue.
  allergens: string[];
  allergens_reviewed_by: string | null;
  allergens_reviewed_at: string | null;
  // N6: usual measure of one each on the master. Weight or volume
  // (lb, oz, fl oz, gal, ...) plus a provenance tag; deriveRecipePrice
  // returns null when both are unset.
  each_measure_qty: number | null;
  each_measure_uom: string | null;
  each_measure_source: string | null;
};
type Vendor = { id: string; name: string };

// Catalog row from pr_vendor_catalog (8,867 rows, 8 vendors loaded as
// of this step). Keyed on (vendor_id, item_number_norm) to join to
// pr_vendor_items. When present the catalog wins for pack / price /
// clean name / gtin; the invoice OCR values stay as the fallback and
// render de-emphasized under the clean name.
type CatalogRow = {
  vendor_id: string;
  item_number_norm: string;
  clean_name: string | null;
  pack_text: string | null;
  catalog_price: number | null;
  gtin: string | null;
};

type AiNewPayload = { proposed_name?: string; proposed_parent?: string | null; reason?: string };

function parseReason(raw: string | null): { prefix: "ai" | "ai-new" | "ai-notfood" | "alias" | "undo" | "other" | null; body: string; aiNew?: AiNewPayload } {
  if (!raw) return { prefix: null, body: "" };
  if (raw.startsWith("ai-new:")) {
    const body = raw.slice("ai-new:".length);
    let aiNew: AiNewPayload = {};
    try { aiNew = JSON.parse(body) as AiNewPayload; } catch { /* ignore - render body raw */ }
    return { prefix: "ai-new", body: aiNew.reason ?? body, aiNew };
  }
  if (raw.startsWith("ai-notfood:")) return { prefix: "ai-notfood", body: raw.slice("ai-notfood:".length) };
  if (raw.startsWith("ai:")) return { prefix: "ai", body: raw.slice("ai:".length) };
  if (raw.startsWith("alias:")) return { prefix: "alias", body: raw.slice("alias:".length) };
  // Polish 3: `undo:<email>` is written server-side (reviewWrites.ts:532)
  // when a confirm is reversed - audit-ledger context, not row-label
  // context. The row card just needs to say the row was undone; the
  // actor sits in the ledger. Render body "Undo" without attribution.
  if (raw.startsWith("undo:")) return { prefix: "undo", body: "Undo" };
  return { prefix: "other", body: raw };
}

async function loadReview() {
  const client = serviceClient();

  // M1 R2 fix 1: detect the migration world once for this request so
  // the items SELECT can conditionally carry case_weight_lb, and the
  // ingredient + item each-measure shapes derive from the new tables
  // instead of the legacy columns.
  const measuresWorld = await isMeasuresWorld(client);

  // Paginated read of every proposed row (PostgREST cap 1000). dollar-ordered.
  // In measures-world we also carry case_weight_lb so the item's eachMeasure
  // can be derived from it. Pre-0019 the column does not exist; we omit it.
  const ITEM_SELECT = measuresWorld
    ? "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_qty,pack_size,pack_uom,pack_state,pack_override,pack_note,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen,flagged,flag_note,flagged_by,flagged_at,price_estimate,grade,each_measure_qty,each_measure_uom,case_weight_lb"
    : "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_qty,pack_size,pack_uom,pack_state,pack_override,pack_note,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen,flagged,flag_note,flagged_by,flagged_at,price_estimate,grade,each_measure_qty,each_measure_uom";
  const items: ProposedItem[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select(ITEM_SELECT)
      .eq("link_status", "proposed")
      .in("status", ["active", "resale"])
      .order("usd_12m", { ascending: false, nullsFirst: false })
      .range(from, from + page - 1);
    if (error) throw error;
    // Cast via unknown: the Supabase JS select-string type parser
    // cannot statically type a template-literal SELECT and bails.
    // The row shape is enforced by ProposedItem's optional
    // case_weight_lb.
    const chunk = (data ?? []) as unknown as ProposedItem[];
    items.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }

  // Vendors + ingredients (both small, read once). category + resale on
  // the ingredient feed the detail panel's category dropdown + resale
  // toggle.
  const [vendorsRes, ingredientsRes, notFoodCountRes] = await Promise.all([
    client.from("pr_vendors").select("id,name"),
    client
      .from("pr_ingredients")
      // N6: each_measure_qty + each_measure_uom + each_measure_source
      // replace N5's avg_weight_lb + avg_weight_source on the ingredient
      // SELECT. Additive against pre-N5; 439 rows, read once, no new
      // query.
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source")
      .eq("status", "active")
      .order("name"),
    client
      .from("pr_vendor_items")
      .select("id", { count: "exact", head: true })
      .like("link_reason", "ai-notfood:%")
      .eq("link_status", "none"),
  ]);
  if (vendorsRes.error) throw vendorsRes.error;
  if (ingredientsRes.error) throw ingredientsRes.error;

  // M1 R3 fix 1: readAllMeasures pages the whole pr_ingredient_measures
  // table (tiny, bounded at 2 rows per ingredient) rather than issuing
  // an .in(523 ids) list that would overrun PostgREST's URL length
  // limit and 500 the page. No ingredient-id filter.
  const measuresByIngredient = measuresWorld
    ? await readAllMeasures(client)
    : new Map<string, never>();
  const ingredientsReshaped: Ingredient[] = ((ingredientsRes.data ?? []) as Ingredient[]).map((r) => {
    if (!measuresWorld) return r;
    const shaped = shapeIngredientEachFromMeasures(measuresByIngredient.get(r.id) ?? []);
    return {
      ...r,
      each_measure_qty: shaped.qty,
      each_measure_uom: shaped.uom,
      each_measure_source: shaped.source,
    };
  });

  // Catalog enrichment: read pr_vendor_catalog in batches grouped by
  // vendor_id, keyed on item_number_norm. Only items with a non-null
  // item_number_norm can match; the rest fall through to invoice-only
  // values. Pattern mirrors the matcher's catalog read (one query per
  // vendor; .in() on the normalized numbers from the queue).
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
        const { data, error } = await client
          .from("pr_vendor_catalog")
          .select("vendor_id,item_number_norm,clean_name,pack_text,catalog_price,gtin")
          .eq("vendor_id", vendorId)
          .in("item_number_norm", slice);
        if (error) throw error;
        for (const r of (data ?? []) as CatalogRow[]) {
          if (!r.item_number_norm) continue;
          catalogByKey.set(`${r.vendor_id}#${r.item_number_norm}`, r);
        }
      }
    }
  }

  // Latest unit_price per vendor_item for the "Unit price" column. We
  // narrow to the vendor_item_ids actually on the queue, then paginate
  // ordered by invoice_date desc and take the first observation per
  // item. Items with no valid observation show "-" in the UI (never a
  // fabricated number). The label makes clear this is the *billed* unit
  // price, not a normalized $/lb across pack sizes (true normalization
  // needs pack parsing, which is step 3).
  const itemIds = items.map((it) => it.id);
  const unitPriceByItem = new Map<string, { unitPrice: number; billedUnit: string | null }>();
  if (itemIds.length > 0) {
    const chunk = 400; // keep the .in list small; PostgREST limits URL length
    for (let i = 0; i < itemIds.length; i += chunk) {
      const slice = itemIds.slice(i, i + chunk);
      let obsFrom = 0;
      for (;;) {
        // N0b + 0015: view = structure; applyCountableFilter = policy.
        const q = client
          .from(COUNTABLE_OBSERVATIONS_VIEW)
          .select("vendor_item_id,unit_price,billed_unit,invoice_date")
          .in("vendor_item_id", slice)
          .not("unit_price", "is", null)
          .order("invoice_date", { ascending: false, nullsFirst: false })
          .range(obsFrom, obsFrom + 999);
        const { data: obsData, error: obsErr } = await applyCountableFilter(q);
        if (obsErr) throw obsErr;
        const page = (obsData ?? []) as Array<{
          vendor_item_id: string;
          unit_price: number | null;
          billed_unit: string | null;
          invoice_date: string | null;
        }>;
        for (const o of page) {
          if (unitPriceByItem.has(o.vendor_item_id)) continue;
          if (o.unit_price == null) continue;
          unitPriceByItem.set(o.vendor_item_id, {
            unitPrice: Number(o.unit_price),
            billedUnit: o.billed_unit,
          });
        }
        if (page.length < 1000) break;
        obsFrom += 1000;
      }
    }
  }

  const vendors = (vendorsRes.data ?? []) as Vendor[];
  // M1 R2 fix 1: use the reshaped list so downstream ingredient reads
  // see the new-world each_measure_* triple (derived from
  // pr_ingredient_measures) in measures-world, legacy columns pre-0019.
  const ingredients = (ingredientsReshaped as unknown as Ingredient[]);
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

  // Group:
  //   key `ex:<ingredient_id>` for existing-ingredient groups
  //   key `new:<proposed_name_lower>` for ai-new groups
  //   notFood items are shown as a count only (filter view later)
  const groups = new Map<string, ReviewCardGroup>();
  for (const it of items) {
    const parsed = parseReason(it.link_reason);
    const u12 = Number(it.usd_12m ?? 0);
    if (it.ingredient_id) {
      const ing = ingredientById.get(it.ingredient_id);
      if (!ing) continue; // orphan - matcher wrote an id that got merged; skip silently
      const key = `ex:${it.ingredient_id}`;
      const g = groups.get(key) ?? {
        key,
        kind: "existing" as const,
        ingredient: ing,
        proposedName: null,
        proposedParent: null,
        totalUsd12m: 0,
        totalLines12m: 0,
        items: [],
      };
      g.totalUsd12m += u12;
      g.totalLines12m += Number(it.lines_12m ?? 0);
      {
        const up = unitPriceByItem.get(it.id) ?? null;
        const cat =
          it.item_number_norm ? catalogByKey.get(`${it.vendor_id}#${it.item_number_norm}`) ?? null : null;
        const catalogClean = cat?.clean_name?.trim() || null;
        const catalogPack = cat?.pack_text?.trim() || null;
        const catalogPrice = cat && cat.catalog_price != null ? Number(cat.catalog_price) : null;
        const gtin = cat?.gtin?.trim() || null;
        const hasManualOverride = isPackManualOverride(it.pack_override);
        const hasPriceOverride = isPriceManualOverride(it.pack_override);
        // Pack precedence: user manual override > catalog > invoice
        // OCR. Each tier carries a source label so the row is clear
        // about which value Kevin's looking at.
        const packDisplay = hasManualOverride
          ? it.pack_text
          : (catalogPack ?? it.pack_text);
        // P1 correction 2c: prefer price_estimate.pack_source when
        // the backfill has stamped a refined value ('catalog_sibling'
        // via the vendor-sibling expansion rule). Raw-column inference
        // misses it; without this a sibling-expanded item reads as
        // "invoice" in the panel even though its pack came from
        // vendor-sibling corroboration.
        const estPackSource =
          it.price_estimate && typeof it.price_estimate.pack_source === "string"
            ? it.price_estimate.pack_source
            : null;
        const packSource: "override" | "catalog" | "invoice" | "catalog_sibling" | null = hasManualOverride
          ? "override"
          : estPackSource === "catalog_sibling"
            ? "catalog_sibling"
            : catalogPack
              ? "catalog"
              : it.pack_text
                ? "invoice"
                : null;
        // Normalized pack display from the backfill: "6/1 LB" style.
        // Falls back to the raw pack text when the backfill hasn't
        // produced qty+size+uom yet.
        const normalizedPack =
          it.pack_qty != null && it.pack_size != null && it.pack_uom
            ? (Number(it.pack_qty) === 1
                ? `${it.pack_size} ${it.pack_uom}`
                : `${it.pack_qty}/${it.pack_size} ${it.pack_uom}`)
            : null;
        const pe = it.price_estimate ?? null;
        const perBase =
          pe && pe.per_base != null && Number.isFinite(Number(pe.per_base))
            ? Number(pe.per_base)
            : null;
        const perBaseConfidence =
          pe && (pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived")
            ? (pe.confidence as "high" | "low" | "override" | "derived")
            : null;
        g.items.push({
          id: it.id,
          name: it.name,
          vendorOcrName: it.name,
          displayName: catalogClean ?? it.name,
          displayNameSource: catalogClean ? "catalog" : "invoice",
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          itemNumber: it.item_number,
          pack: packDisplay,
          packNormalized: normalizedPack,
          packUom: it.pack_uom,
          packState: it.pack_state,
          packSource,
          packManualOverride: hasManualOverride,
          priceManualOverride: hasPriceOverride,
          billedUnit: it.billed_unit,
          usd12m: u12,
          lines12m: Number(it.lines_12m ?? 0),
          accounts: it.accounts ?? [],
          accountsCount: (it.accounts ?? []).length,
          lastSeen: it.last_seen,
          confidence: it.link_confidence,
          reason: parsed.body,
          catchWeight: it.catch_weight,
          unitPrice: up ? up.unitPrice : null,
          unitPriceUnit: up ? up.billedUnit ?? it.billed_unit : null,
          catalogPrice,
          gtin,
          perBase,
          perBaseUom: pe?.base_uom ?? null,
          perBaseConfidence,
          perBaseNote: pe?.note ?? null,
          storedCasePrice: pe?.case_price != null && Number.isFinite(Number(pe.case_price)) ? Number(pe.case_price) : null,
          caseSource: (pe?.case_price_source as "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | "actuals_base_unit" | "actuals_weight" | "actuals_case" | null) ?? null,
          flagged: it.flagged === true,
          flagNote: it.flag_note ?? null,
          flaggedBy: it.flagged_by ?? null,
          flaggedAt: it.flagged_at ?? null,
          // G1: tier on the item.
          grade: it.grade ?? null,
          // P1 §5: pack provenance (how the catalog row was matched).
          matchSource:
            pe?.match_source === "sku" || pe?.match_source === "catalog_name"
              ? pe.match_source
              : null,
          matchScore:
            pe?.match_score != null && Number.isFinite(Number(pe.match_score))
              ? Number(pe.match_score)
              : null,
          // Q2 §4: pack-note (evidence-strength phrase from the P1/P2
          // backfill). Pass through verbatim; null for most items.
          packNote: it.pack_note ?? null,
          // M1 R2 fix 1 + R3 fix 2: in measures-world, case_weight_lb
          // decides whether the item has an override and what it is
          // worth. The legacy pair (when consistent with the case
          // weight within 1 percent) decides how to SHOW it. Pre-0019
          // we fall back to the legacy pair unchanged.
          eachMeasure: measuresWorld
            ? shapeItemEachFromCaseWeight(
                it.case_weight_lb ?? null,
                it.pack_qty,
                it.pack_size,
                it.pack_uom,
                it.each_measure_qty,
                it.each_measure_uom,
              )
            : it.each_measure_qty != null && it.each_measure_uom
              ? { qty: Number(it.each_measure_qty), uom: it.each_measure_uom }
              : null,
        });
      }
      groups.set(key, g);
    } else if (parsed.prefix === "ai-new" && parsed.aiNew?.proposed_name) {
      const nameKey = parsed.aiNew.proposed_name.trim().toLowerCase();
      const key = `new:${nameKey}`;
      const g = groups.get(key) ?? {
        key,
        kind: "new" as const,
        ingredient: null,
        proposedName: parsed.aiNew.proposed_name.trim(),
        proposedParent: parsed.aiNew.proposed_parent ?? null,
        totalUsd12m: 0,
        totalLines12m: 0,
        items: [],
      };
      g.totalUsd12m += u12;
      g.totalLines12m += Number(it.lines_12m ?? 0);
      {
        const up = unitPriceByItem.get(it.id) ?? null;
        const cat =
          it.item_number_norm ? catalogByKey.get(`${it.vendor_id}#${it.item_number_norm}`) ?? null : null;
        const catalogClean = cat?.clean_name?.trim() || null;
        const catalogPack = cat?.pack_text?.trim() || null;
        const catalogPrice = cat && cat.catalog_price != null ? Number(cat.catalog_price) : null;
        const gtin = cat?.gtin?.trim() || null;
        const hasManualOverride = isPackManualOverride(it.pack_override);
        const hasPriceOverride = isPriceManualOverride(it.pack_override);
        // Pack precedence: user manual override > catalog > invoice
        // OCR. Each tier carries a source label so the row is clear
        // about which value Kevin's looking at.
        const packDisplay = hasManualOverride
          ? it.pack_text
          : (catalogPack ?? it.pack_text);
        // P1 correction 2c: prefer price_estimate.pack_source when
        // the backfill has stamped a refined value ('catalog_sibling'
        // via the vendor-sibling expansion rule). Raw-column inference
        // misses it; without this a sibling-expanded item reads as
        // "invoice" in the panel even though its pack came from
        // vendor-sibling corroboration.
        const estPackSource =
          it.price_estimate && typeof it.price_estimate.pack_source === "string"
            ? it.price_estimate.pack_source
            : null;
        const packSource: "override" | "catalog" | "invoice" | "catalog_sibling" | null = hasManualOverride
          ? "override"
          : estPackSource === "catalog_sibling"
            ? "catalog_sibling"
            : catalogPack
              ? "catalog"
              : it.pack_text
                ? "invoice"
                : null;
        // Normalized pack display from the backfill: "6/1 LB" style.
        // Falls back to the raw pack text when the backfill hasn't
        // produced qty+size+uom yet.
        const normalizedPack =
          it.pack_qty != null && it.pack_size != null && it.pack_uom
            ? (Number(it.pack_qty) === 1
                ? `${it.pack_size} ${it.pack_uom}`
                : `${it.pack_qty}/${it.pack_size} ${it.pack_uom}`)
            : null;
        const pe = it.price_estimate ?? null;
        const perBase =
          pe && pe.per_base != null && Number.isFinite(Number(pe.per_base))
            ? Number(pe.per_base)
            : null;
        const perBaseConfidence =
          pe && (pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived")
            ? (pe.confidence as "high" | "low" | "override" | "derived")
            : null;
        g.items.push({
          id: it.id,
          name: it.name,
          vendorOcrName: it.name,
          displayName: catalogClean ?? it.name,
          displayNameSource: catalogClean ? "catalog" : "invoice",
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          itemNumber: it.item_number,
          pack: packDisplay,
          packNormalized: normalizedPack,
          packUom: it.pack_uom,
          packState: it.pack_state,
          packSource,
          packManualOverride: hasManualOverride,
          priceManualOverride: hasPriceOverride,
          billedUnit: it.billed_unit,
          usd12m: u12,
          lines12m: Number(it.lines_12m ?? 0),
          accounts: it.accounts ?? [],
          accountsCount: (it.accounts ?? []).length,
          lastSeen: it.last_seen,
          confidence: it.link_confidence,
          reason: parsed.body,
          catchWeight: it.catch_weight,
          unitPrice: up ? up.unitPrice : null,
          unitPriceUnit: up ? up.billedUnit ?? it.billed_unit : null,
          catalogPrice,
          gtin,
          perBase,
          perBaseUom: pe?.base_uom ?? null,
          perBaseConfidence,
          perBaseNote: pe?.note ?? null,
          storedCasePrice: pe?.case_price != null && Number.isFinite(Number(pe.case_price)) ? Number(pe.case_price) : null,
          caseSource: (pe?.case_price_source as "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | "actuals_base_unit" | "actuals_weight" | "actuals_case" | null) ?? null,
          flagged: it.flagged === true,
          flagNote: it.flag_note ?? null,
          flaggedBy: it.flagged_by ?? null,
          flaggedAt: it.flagged_at ?? null,
          // G1: tier on the item.
          grade: it.grade ?? null,
          // P1 §5: pack provenance (how the catalog row was matched).
          matchSource:
            pe?.match_source === "sku" || pe?.match_source === "catalog_name"
              ? pe.match_source
              : null,
          matchScore:
            pe?.match_score != null && Number.isFinite(Number(pe.match_score))
              ? Number(pe.match_score)
              : null,
          // Q2 §4: pack-note (evidence-strength phrase from the P1/P2
          // backfill). Pass through verbatim; null for most items.
          packNote: it.pack_note ?? null,
          // M1 R2 fix 1 + R3 fix 2: in measures-world, case_weight_lb
          // decides whether the item has an override and what it is
          // worth. The legacy pair (when consistent with the case
          // weight within 1 percent) decides how to SHOW it. Pre-0019
          // we fall back to the legacy pair unchanged.
          eachMeasure: measuresWorld
            ? shapeItemEachFromCaseWeight(
                it.case_weight_lb ?? null,
                it.pack_qty,
                it.pack_size,
                it.pack_uom,
                it.each_measure_qty,
                it.each_measure_uom,
              )
            : it.each_measure_qty != null && it.each_measure_uom
              ? { qty: Number(it.each_measure_qty), uom: it.each_measure_uom }
              : null,
        });
      }
      groups.set(key, g);
    }
    // Items with link_status='proposed' but no ingredient_id and no ai-new
    // reason are malformed - skip silently; a future hotfix can surface them.
  }

  // M2 §4B: post-pass fills perBaseInIngUnit on every item in an
  // existing-ingredient group via the one price function. ai-new
  // groups have no confirmed target so perBaseInIngUnit stays null.
  // Reads measures already batch-loaded above; one priceInUnit call
  // per item, no new query.
  const itemsById = new Map(items.map((it) => [it.id, it]));
  for (const g of groups.values()) {
    if (g.kind !== "existing" || !g.ingredient) continue;
    const ing = g.ingredient;
    const target = canonicalFromBaseUnit(ing.base_unit);
    const ms = measuresWorld ? (measuresByIngredient.get(ing.id) ?? []) : [];
    for (const vi of g.items) {
      const raw = itemsById.get(vi.id);
      if (!raw) continue;
      const pe = raw.price_estimate ?? null;
      const perBase = pe?.per_base != null ? Number(pe.per_base) : null;
      const baseUom = pe?.base_uom ?? null;
      vi.caseWeightLb = raw.case_weight_lb ?? null;
      vi.perBaseInIngUnit =
        perBase != null && baseUom && target
          ? priceInUnit(
              {
                perBase,
                baseUom,
                packQty: raw.pack_qty ?? null,
                packSize: raw.pack_size ?? null,
                packUom: raw.pack_uom ?? null,
                caseWeightLb: raw.case_weight_lb ?? null,
              },
              target,
              { measures: ms },
            )?.per ?? null
          : null;
    }
  }

  // Sort member items inside each group dollar-desc; sort groups dollar-desc.
  const groupList = Array.from(groups.values()).map((g) => ({
    ...g,
    items: g.items.sort((a, b) => b.usd12m - a.usd12m),
  }));
  groupList.sort((a, b) => b.totalUsd12m - a.totalUsd12m);

  // Overall totals.
  const totalItems = items.length;
  const totalUsd = items.reduce((s, it) => s + Number(it.usd_12m ?? 0), 0);
  const groupedUsd = groupList.reduce((s, g) => s + g.totalUsd12m, 0);
  const notFoodCount = notFoodCountRes.count ?? 0;

  return {
    groups: groupList,
    ingredients,
    totals: { items: totalItems, usd: totalUsd, groupedUsd, groups: groupList.length, notFood: notFoodCount },
  };
}

export async function ReviewQueue() {
  const { groups, ingredients, totals } = await loadReview();

  return (
    <div className="kf-ing">
      {/* Polish 6: Overview-style hero header. Same IdentBand the
          Overview tab uses; no description row (kick omitted); no CTA
          (Run intake stays in the top bar). Stats are the two facts
          the retired .kf-review__meta white strip used to carry -
          same props, new home. */}
      <IdentBand
        eyebrow="Culinary office"
        title="Review queue"
        facts={[
          {
            label: "Proposals",
            value: fmtCount(totals.items),
            note: `${fmtUsd(totals.usd)} · ${fmtCount(totals.groups)} groups`,
          },
          {
            label: "Flagged not food",
            value: fmtCount(totals.notFood),
            note: "matcher called them not food",
          },
        ]}
      />

      <Tabs active="review" />

      {groups.length === 0 ? (
        <div className="kf-empty">
          <div>
            <div className="kf-empty__title">No proposals waiting</div>
            <div className="kf-empty__body">
              Run the matcher (<code>POST /api/match</code>) to populate this queue; or confirm what&rsquo;s
              already linked on the vendor-items table.
            </div>
          </div>
        </div>
      ) : (
        <ReviewFilter
          groups={groups.map(toFilterGroup)}
          cards={groups.map((g) => ({
            key: g.key,
            node: <ReviewCard group={g} ingredients={ingredients} />,
          }))}
          totals={{
            items: totals.items,
            usd: totals.usd,
            groups: totals.groups,
            notFood: totals.notFood,
            groupedUsd: totals.groupedUsd,
          }}
        />
      )}

      <ReviewLedger ingredients={ingredients} />
    </div>
  );
}

// Project the richer server-side group into the narrow shape the client
// filter needs. Only serializable fields; no React elements or
// functions.
function toFilterGroup(g: ReviewCardGroup): ReviewFilterGroup {
  const latestLastSeen = g.items.reduce<string | null>((acc, it) => {
    if (!it.lastSeen) return acc;
    if (!acc) return it.lastSeen;
    return it.lastSeen > acc ? it.lastSeen : acc;
  }, null);
  return {
    key: g.key,
    kind: g.kind,
    ingredientName: g.ingredient?.name ?? null,
    ingredientParent: g.ingredient?.parent ?? null,
    // category + resale carry the super-category and resale flag to the
    // client-side filters.
    //
    // For an existing-ingredient group the category is the ingredient's
    // own. For an ai-new group there is no ingredient yet, so derive the
    // would-be super-category from the matcher's proposed parent - the
    // SAME derivation the create form already uses to pre-fill its two
    // dropdowns (ReviewActions.tsx newSuper/subPick).
    //
    // Reading the absent ingredient instead made EVERY ai-new group count
    // as "Needs category" - 750 groups on 2026-11-09 when zero of them
    // actually lacked a derivable one - and left the seven super-category
    // chips blind to three quarters of the queue. The chip must mean "no
    // category is derivable", never "no ingredient exists yet".
    category: g.ingredient?.category ?? categoryForParent(g.proposedParent),
    resale: g.ingredient?.resale ?? false,
    proposedName: g.proposedName,
    proposedParent: g.proposedParent,
    totalUsd12m: g.totalUsd12m,
    totalLines12m: g.totalLines12m,
    memberCount: g.items.length,
    members: g.items.map((it) => ({ name: it.name, vendor: it.vendor })),
    lastSeen: latestLastSeen,
  };
}
