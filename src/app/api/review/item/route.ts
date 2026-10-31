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
import type { ReviewCardIngredient, ReviewGroupItem } from "@/components/ingredients/itemTypes";

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
      "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_qty,pack_size,pack_uom,pack_state,pack_override,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen,flagged,flag_note,flagged_by,flagged_at,price_estimate"
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
      confidence?: string | null;
      note?: string | null;
    } | null;
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
    client
      .from("pr_price_observations")
      .select("unit_price,billed_unit,invoice_date")
      .eq("vendor_item_id", it.id)
      .is("excluded_reason", null)
      .not("unit_price", "is", null)
      .order("invoice_date", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    it.ingredient_id
      ? client
          .from("pr_ingredients")
          .select("id,name,parent,category,resale")
          .eq("id", it.ingredient_id)
          .maybeSingle()
      : Promise.resolve({ data: null as unknown, error: null }),
    client
      .from("pr_ingredients")
      .select("id,name,parent,category,resale")
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
  const hasManualOverride = it.pack_override !== null;
  const packDisplay = hasManualOverride ? it.pack_text : catalogPack ?? it.pack_text;
  const packSource: "override" | "catalog" | "invoice" | null = hasManualOverride
    ? "override"
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
  const pe = it.price_estimate ?? null;
  const perBase =
    pe && pe.per_base != null && Number.isFinite(Number(pe.per_base)) ? Number(pe.per_base) : null;
  const perBaseConfidence =
    pe && (pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived")
      ? (pe.confidence as "high" | "low" | "override" | "derived")
      : null;
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
    packState: it.pack_state,
    packSource,
    packManualOverride: hasManualOverride,
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
    perBaseUom: pe?.base_uom ?? null,
    perBaseConfidence,
    perBaseNote: pe?.note ?? null,
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
  };

  const ingredient = (ingredientRes.data as ReviewCardIngredient | null) ?? null;
  const parents = (parentsRes.data ?? []) as ReviewCardIngredient[];

  return NextResponse.json({ item, ingredient, parents });
}
