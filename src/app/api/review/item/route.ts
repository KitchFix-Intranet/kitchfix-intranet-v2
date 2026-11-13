// GET /api/review/item?id=<uuid>
//
// Returns the facts one vendor item needs to fill the DetailPanel:
//   { item: ReviewGroupItem; ingredient: ReviewCardIngredient | null;
//     parents: ReviewCardIngredient[] }
//
// Introduced by Prompt A1 so the Ingredients pane can open the same
// DetailPanel the Review queue uses. The queue component (ReviewQueue)
// hands those three props in from props it already has in memory; the
// Ingredients pane only holds a thin MasterLinkedItem per row, so the
// panel needs a second way in - by itemId, fetching its own facts.
//
// The ReviewGroupItem mapping below mirrors ReviewQueue.tsx verbatim
// (same expressions, same semantics) so the panel reads identical
// values from either door. If this file and ReviewQueue drift, the
// panel will quietly show different numbers for the same item.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { COUNTABLE_OBSERVATIONS_VIEW, applyCountableFilter } from "@/lib/ingredients/countability";
import {
  isPackManualOverride,
  isPriceManualOverride,
  type ReviewCardIngredient,
  type ReviewGroupItem,
} from "@/components/ingredients/itemTypes";
import { readPerBase } from "@/lib/ingredients/priceEstimate";
import {
  isMeasuresWorld,
  readMeasuresForIngredient,
  legacyEachMeasureToMeasures,
} from "@/lib/ingredients/measuresRead";
// M2 §4B part 2: shape helpers no longer called here. Nothing on
// screen reads each_measure_*; the GET returns the raw legacy
// values when present (type-level back-compat) and the real
// authority lives in the `measures` field.
import { priceInUnit, sizesDifferFlags } from "@/lib/ingredients/measures";
import { canonicalFromBaseUnit } from "@/lib/ingredients/pack";
// Polish round 2 fix 2: the ingredient payload carries the blended
// lens's $ / base_unit so attention's outlier head can read one
// number across every door. blendStats is the same code path the
// Ingredients tab uses, so the figure matches.
import { blendStats } from "@/lib/ingredients/blend";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AiNewPayload = { proposed_name?: string; proposed_parent?: string | null; reason?: string };

function parseReason(raw: string | null): { body: string } {
  if (!raw) return { body: "" };
  if (raw.startsWith("ai-new:")) {
    const body = raw.slice("ai-new:".length);
    try {
      const aiNew = JSON.parse(body) as AiNewPayload;
      return { body: aiNew.reason ?? body };
    } catch {
      return { body };
    }
  }
  if (raw.startsWith("ai-notfood:")) return { body: raw.slice("ai-notfood:".length) };
  if (raw.startsWith("ai:")) return { body: raw.slice("ai:".length) };
  if (raw.startsWith("alias:")) return { body: raw.slice("alias:".length) };
  return { body: raw };
}

export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Reject malformed uuids at the edge so Postgres never sees them -
  // otherwise .eq("id", "abc") trips a 500 from the type cast.
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id must be a uuid" }, { status: 400 });

  const client = serviceClient();

  const { data: itRow, error: itErr } = await client
    .from("pr_vendor_items")
    .select(
      // N13 R3: five columns added (needs_review_lines, first_seen,
      // status, is_food, food_reason) so the item panel can carry the
      // facts the old VendorItemDrawer displayed. Additive only.
      "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_qty,pack_size,pack_uom,pack_state,pack_override,pack_note,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen,flagged,flag_note,flagged_by,flagged_at,price_estimate,grade,each_measure_qty,each_measure_uom,needs_review_lines,first_seen,status,is_food,food_reason"
    )
    .eq("id", id)
    .maybeSingle();
  if (itErr) return NextResponse.json({ error: itErr.message }, { status: 500 });
  if (!itRow) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const it = itRow as {
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
      // P1 §5: catalog match provenance (sku vs catalog_name trigram).
      match_source?: string | null;
      match_score?: number | null;
      confidence?: string | null;
      note?: string | null;
    } | null;
    grade: string | null;
    // N6: per-item each measure override. Both null for most rows.
    each_measure_qty: number | null;
    each_measure_uom: string | null;
    // N13 R3: additive columns for the item-panel surfaces that used
    // to live inside VendorItemDrawer.
    needs_review_lines: number | null;
    first_seen: string | null;
    status: string;
    is_food: boolean | null;
    food_reason: string | null;
  };

  // Enrichment reads: vendor name, catalog match (if the item has a
  // normalized number), latest observed unit price, the item's own
  // ingredient and the full parents list for the panel's sub-category
  // dropdown. All run in parallel.
  const [vendorRes, catalogRes, obsRes, ingredientRes, parentsRes] = await Promise.all([
    client.from("pr_vendors").select("id,name").eq("id", it.vendor_id).maybeSingle(),
    it.item_number_norm
      ? client
          .from("pr_vendor_catalog")
          .select("vendor_id,item_number_norm,clean_name,pack_text,catalog_price,gtin")
          .eq("vendor_id", it.vendor_id)
          .eq("item_number_norm", it.item_number_norm)
          .maybeSingle()
      : Promise.resolve({ data: null as unknown, error: null }),
    // N0b + 0015: view = structure; applyCountableFilter = policy.
    applyCountableFilter(
      client
        .from(COUNTABLE_OBSERVATIONS_VIEW)
        .select("unit_price,billed_unit,invoice_date")
        .eq("vendor_item_id", it.id)
        .not("unit_price", "is", null)
        .order("invoice_date", { ascending: false, nullsFirst: false })
        .limit(1)
    ).maybeSingle(),
    it.ingredient_id
      ? client
          .from("pr_ingredients")
          // N5: avg_weight_lb + avg_weight_source added to the two
          // ingredient SELECTs so the panel reads what is stored.
          .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source,yield_pct,yield_source")
          .eq("id", it.ingredient_id)
          .maybeSingle()
      : Promise.resolve({ data: null as unknown, error: null }),
    client
      .from("pr_ingredients")
      // N5: avg_weight_lb + avg_weight_source on the parents list too.
      .select("id,name,parent,category,resale,base_unit,allergens,allergens_reviewed_by,allergens_reviewed_at,each_measure_qty,each_measure_uom,each_measure_source,yield_pct,yield_source")
      .eq("status", "active")
      .order("name"),
  ]);
  if (vendorRes.error) return NextResponse.json({ error: vendorRes.error.message }, { status: 500 });
  if (parentsRes.error) return NextResponse.json({ error: parentsRes.error.message }, { status: 500 });

  const vendorName = (vendorRes.data as { name?: string } | null)?.name ?? it.vendor_id;
  const cat = (catalogRes.data as {
    clean_name: string | null;
    pack_text: string | null;
    catalog_price: number | null;
    gtin: string | null;
  } | null) ?? null;
  const up = (obsRes.data as {
    unit_price: number | null;
    billed_unit: string | null;
    invoice_date: string | null;
  } | null) ?? null;

  // Mirrors ReviewQueue.tsx:248-323 verbatim - same expressions, same
  // semantics. If anything in that block changes, update this too.
  const catalogClean = cat?.clean_name?.trim() || null;
  const catalogPack = cat?.pack_text?.trim() || null;
  const catalogPrice = cat && cat.catalog_price != null ? Number(cat.catalog_price) : null;
  const gtin = cat?.gtin?.trim() || null;
  const hasManualOverride = isPackManualOverride(it.pack_override);
  const hasPriceOverride = isPriceManualOverride(it.pack_override);
  const packDisplay = hasManualOverride ? it.pack_text : catalogPack ?? it.pack_text;
  // P1 correction 2c: prefer price_estimate.pack_source when the
  // backfill has stamped it with a refined value ('catalog_sibling'
  // or 'catalog_name' via match_source). The raw-column inference
  // below only sees pack_text and the catalog join, so a sibling-
  // expanded item would read "invoice" by inference even though its
  // pack came from a vendor-sibling expansion. Hand-overrides still
  // win at the top.
  const pe = it.price_estimate ?? null;
  const estimatePackSource =
    pe && typeof pe.pack_source === "string" ? pe.pack_source : null;
  const packSource: "override" | "catalog" | "invoice" | "catalog_sibling" | null = hasManualOverride
    ? "override"
    : estimatePackSource === "catalog_sibling"
      ? "catalog_sibling"
      : catalogPack
        ? "catalog"
        : it.pack_text
          ? "invoice"
          : null;
  const normalizedPack =
    it.pack_qty != null && it.pack_size != null && it.pack_uom
      ? Number(it.pack_qty) === 1
        ? `${it.pack_size} ${it.pack_uom}`
        : `${it.pack_qty}/${it.pack_size} ${it.pack_uom}`
      : null;
  // N13 §3.3: perBase + perBaseUom + confidence + note come from one
  // helper so VendorItemsPage's row-shaping reads the same values with
  // no risk of drift. The output below is byte-identical to the prior
  // inline derivation.
  const { perBase, perBaseUom: perBaseUomFromPe, perBaseConfidence, perBaseNote } = readPerBase(pe);
  const parsed = parseReason(it.link_reason);
  const u12 = Number(it.usd_12m ?? 0);

  const item: ReviewGroupItem = {
    id: it.id,
    name: it.name,
    vendorOcrName: it.name,
    displayName: catalogClean ?? it.name,
    displayNameSource: catalogClean ? "catalog" : "invoice",
    vendor: vendorName,
    itemNumber: it.item_number,
    pack: packDisplay,
    packNormalized: normalizedPack,
    packUom: it.pack_uom ?? null,
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
    unitPrice: up?.unit_price != null ? Number(up.unit_price) : null,
    unitPriceUnit: up ? up.billed_unit ?? it.billed_unit : null,
    catalogPrice,
    gtin,
    perBase,
    perBaseUom: perBaseUomFromPe,
    perBaseConfidence,
    perBaseNote,
    storedCasePrice:
      pe?.case_price != null && Number.isFinite(Number(pe.case_price))
        ? Number(pe.case_price)
        : null,
    caseSource:
      (pe?.case_price_source as
        | "catalog"
        | "billed"
        | "catch_weight"
        | "catalog_lb"
        | "override"
        | "actuals_base_unit"
        | "actuals_weight"
        | "actuals_case"
        | null) ?? null,
    flagged: it.flagged === true,
    flagNote: it.flag_note ?? null,
    flaggedBy: it.flagged_by ?? null,
    flaggedAt: it.flagged_at ?? null,
    // G1: tier on the item. Null is standard; 'premium' is the only
    // sanctioned non-null value today.
    grade: it.grade ?? null,
    // Q2 §4: packNote is written by the P1/P2 backfill with evidence-
    // strength copy ("inferred from N similar items at this vendor;
    // verify"). Pre-Q2 this field was written and never read - the
    // panel had no reader. Now surfaced to the panel so a reviewer
    // can see whether a sibling-filled pack was backed by 1 similar
    // item or 12.
    packNote: it.pack_note ?? null,
    // N6: per-item each measure override. Null for most rows.
    eachMeasure: it.each_measure_qty != null && it.each_measure_uom
      ? { qty: Number(it.each_measure_qty), uom: it.each_measure_uom }
      : null,
    // P1 §5: catalog match provenance. The panel's ItemFacts reads
    // this alongside packSource to label the pack's origin in plain
    // words ("from catalog", "from catalog (name match)", etc.).
    matchSource:
      pe?.match_source === "sku" || pe?.match_source === "catalog_name"
        ? pe.match_source
        : null,
    matchScore:
      pe?.match_score != null && Number.isFinite(Number(pe.match_score))
        ? Number(pe.match_score)
        : null,
    // N13 R3: five additive fields so the item panel carries what
    // VendorItemDrawer displayed. isFood is TRI-STATE on the wire
    // (round 2 fix 2): null means legacy / unknown, not food. The
    // "Not food" pill only renders when is_food is strictly false,
    // so the response must preserve null.
    needsReviewLines: Number(it.needs_review_lines ?? 0),
    firstSeen: it.first_seen,
    status: it.status,
    isFood: it.is_food,
    foodReason: it.food_reason,
  };

  const rawIngredient = (ingredientRes.data as ReviewCardIngredient | null) ?? null;
  const parents = (parentsRes.data ?? []) as ReviewCardIngredient[];

  // M1 R2 fix 1 + amendment 4: one world per request. In measures-
  // world, rewrite the LEGACY-SHAPED FIELDS downstream readers feed
  // into deriveRecipePrice (ingredient.each_measure_* and
  // item.eachMeasure) so the display pipeline sees the new numbers.
  const newWorld = await isMeasuresWorld(client);
  let measures: ReturnType<typeof legacyEachMeasureToMeasures> = [];
  let caseWeightLb: number | null = null;
  let ingredient: ReviewCardIngredient | null = rawIngredient;
  let itemEachMeasure: { qty: number; uom: string } | null = item.eachMeasure;
  if (newWorld) {
    if (rawIngredient) {
      measures = await readMeasuresForIngredient(client, rawIngredient.id);
      // M2 §4B part 2: screens don't read each_measure_* any more.
      // The ingredient passes through with its legacy columns intact
      // (type-level back-compat); the authoritative shape is
      // `measures` which rides on the response below.
      ingredient = rawIngredient;
    }
    const { data: cwRow } = await client
      .from("pr_vendor_items")
      .select("case_weight_lb")
      .eq("id", id)
      .maybeSingle();
    const raw = (cwRow as { case_weight_lb: number | null } | null)?.case_weight_lb ?? null;
    caseWeightLb = raw == null ? null : Number(raw);
    // item.eachMeasure is unread on screen; kept as-is.
    itemEachMeasure = item.eachMeasure;
  } else if (rawIngredient) {
    measures = legacyEachMeasureToMeasures(
      rawIngredient.each_measure_qty,
      rawIngredient.each_measure_uom,
      rawIngredient.each_measure_source,
    );
  }
  const ingWithYield = ingredient as (ReviewCardIngredient & { yield_pct?: number | null; yield_source?: string | null }) | null;
  const yieldPct =
    ingWithYield && ingWithYield.yield_pct != null
      ? Number(ingWithYield.yield_pct)
      : null;
  const yieldSource = ingWithYield?.yield_source ?? null;

  // M2 R1 amendment 3: item API calls priceInUnit so the panel strip
  // + "How we got there" can read $ in the ingredient's base_unit
  // from the one price function. Null when no ingredient, no price,
  // or no reachable path.
  let perBaseInIngUnit: number | null = null;
  let statusKind: "in_blend" | "check_it" | "needs_measure" | "sizes_differ" = "in_blend";
  const pe2 = it.price_estimate ?? null;
  const rawPerBase = pe2?.per_base != null ? Number(pe2.per_base) : null;
  const rawBaseUom = pe2?.base_uom ?? null;
  if (ingredient && rawPerBase != null && rawBaseUom) {
    const targetUom = canonicalFromBaseUnit(ingredient.base_unit);
    if (targetUom) {
      const r = priceInUnit(
        {
          perBase: rawPerBase,
          baseUom: rawBaseUom,
          packQty: it.pack_qty,
          packSize: it.pack_size,
          packUom: it.pack_uom,
          caseWeightLb,
        },
        targetUom,
        { measures },
      );
      perBaseInIngUnit = r?.per ?? null;
      if (perBaseInIngUnit == null) {
        statusKind = "needs_measure";
      } else {
        // M2 §4B part 3: compute sizes_differ for this single item
        // by loading its ingredient-mates' pack shapes. We skip for
        // non-count-costed ingredients (helper returns an empty
        // set for those).
        const { data: mates } = await client
          .from("pr_vendor_items")
          .select("id,pack_qty,pack_size,pack_uom")
          .eq("ingredient_id", ingredient.id);
        const packs = (mates ?? []).map((row) => {
          const r = row as { id: string; pack_qty: number | null; pack_size: number | null; pack_uom: string | null };
          return { id: r.id, packQty: r.pack_qty, packSize: r.pack_size, packUom: r.pack_uom };
        });
        const flagged = sizesDifferFlags(packs, measures, ingredient.base_unit);
        if (flagged.has(it.id)) statusKind = "sizes_differ";
        // check_it is per-blend classification; the server doesn't
        // know it for a single item without the full priced set,
        // and the attention surface only needs it when known.
        // (MasterLinkedItem carries it from IngredientMasters.)
      }
    } else {
      statusKind = "needs_measure";
    }
  }

  const itemOut = {
    ...item,
    eachMeasure: itemEachMeasure,
    caseWeightLb,
    perBaseInIngUnit,
    statusKind,
  } as ReviewGroupItem & { caseWeightLb: number | null; perBaseInIngUnit: number | null };

  // Polish round 2 fix 2: blended lens $ / base_unit across THIS
  // ingredient's linked items (not the Review-queue group). Each
  // mate's per-base is routed through priceInUnit so weight items
  // and count items both land in the ingredient's dim before the
  // outlier rule runs. blendStats is the same code path that
  // IngredientMasters uses for the blended lens; the number matches.
  let blendedAvgPerBase: number | null = null;
  if (ingredient) {
    const targetUom = canonicalFromBaseUnit(ingredient.base_unit);
    if (targetUom) {
      const { data: mates } = await client
        .from("pr_vendor_items")
        .select("id,pack_qty,pack_size,pack_uom,case_weight_lb,price_estimate,usd_12m")
        .eq("ingredient_id", ingredient.id);
      const priced: Array<{ id: string; v: number; usd: number }> = [];
      for (const row of (mates ?? []) as Array<{
        id: string;
        pack_qty: number | null;
        pack_size: number | null;
        pack_uom: string | null;
        case_weight_lb: number | null;
        price_estimate: { per_base?: number | string | null; base_uom?: string | null } | null;
        usd_12m: number | null;
      }>) {
        const pe = row.price_estimate ?? null;
        const matePerBase = pe?.per_base != null ? Number(pe.per_base) : null;
        const mateBaseUom = pe?.base_uom ?? null;
        if (matePerBase == null || !Number.isFinite(matePerBase) || matePerBase <= 0 || !mateBaseUom) continue;
        const r = priceInUnit(
          {
            perBase: matePerBase,
            baseUom: mateBaseUom,
            packQty: row.pack_qty,
            packSize: row.pack_size,
            packUom: row.pack_uom,
            caseWeightLb: row.case_weight_lb,
          },
          targetUom,
          { measures },
        );
        if (r?.per != null && Number.isFinite(r.per) && r.per > 0) {
          priced.push({ id: row.id, v: r.per, usd: Number(row.usd_12m ?? 0) });
        }
      }
      const stats = blendStats(priced);
      blendedAvgPerBase = stats.survivorMean;
    }
  }

  // M2 §4B part 2: project measures + yield onto the ingredient
  // object itself so panel readers see one shape.
  const ingredientOut = ingredient
    ? { ...ingredient, measures, yieldPct, yieldSource, blendedAvgPerBase }
    : null;
  return NextResponse.json({
    item: itemOut,
    ingredient: ingredientOut,
    parents,
    measures,
    yieldPct,
    yieldSource,
  });
}
