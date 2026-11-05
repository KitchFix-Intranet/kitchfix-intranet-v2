// GET /api/review/item-evidence?id=<uuid>
//
// Returns the proof surface for the DetailPanel's Evidence section
// (A3b). Loaded lazily on first expand - the panel-open feed stays
// in /api/review/item, keyed to the 17 fields the chain needs.
//
// Four groups, each omitted client-side when empty:
//   invoiceLines   -- recent pr_price_observations for this item,
//                     catch-weight-aware (billed weight when the
//                     item is catch-weight, quantity otherwise)
//   bySite         -- same observations rolled up by account_key
//   siblings       -- other vendor items linked to this ingredient,
//                     for "is this expensive here?" comparisons
//   variants       -- OCR name spellings folded under the same
//                     (vendor_id, item_number_norm) key
//
// Source reuse: pr_price_observations is the same table
// pack-backfill/route.ts:325 reads for the Tier B / Tier C weight
// aggregates and setVendorItemPackOverride uses for latest unit
// price. No new query shape; PotRack still writes only pr_ tables
// and reads intranet tables read-only (unchanged by A3b).

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { applyCountableFilter } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obs = {
  invoice_date: string | null;
  account_key: string | null;
  unit_price: number | null;
  quantity: number | null;
  extended_price: number | null;
  billed_unit: string | null;
  weight_line_value: number | null;
};

export async function GET(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id must be a uuid" }, { status: 400 });

  const client = serviceClient();

  // Need vendor_id + item_number_norm + ingredient_id + catch_weight
  // to drive the three enrichment groups. One point lookup.
  const { data: itRow, error: itErr } = await client
    .from("pr_vendor_items")
    .select("id,vendor_id,item_number_norm,ingredient_id,catch_weight")
    .eq("id", id)
    .maybeSingle();
  if (itErr) return NextResponse.json({ error: itErr.message }, { status: 500 });
  if (!itRow) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const it = itRow as {
    id: string;
    vendor_id: string;
    item_number_norm: string | null;
    ingredient_id: string | null;
    catch_weight: boolean;
  };

  // Paginated read of every observation on this item (standard 1000
  // row cap). Items in production carry tens, not thousands, so one
  // page is usually enough.
  const observations: Obs[] = [];
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const q = client
        .from("pr_price_observations")
        .select(
          "invoice_date,account_key,unit_price,quantity,extended_price,billed_unit,weight_line_value"
        )
        .eq("vendor_item_id", it.id)
        .order("invoice_date", { ascending: false, nullsFirst: false })
        .range(from, from + PAGE - 1);
      // N0: countability predicate via shared helper.
      const { data, error } = await applyCountableFilter(q);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const rows = (data ?? []) as Obs[];
      observations.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }

  // Lines: top 50 most-recent for the table. The full set still
  // feeds bySite.
  const invoiceLines = observations.slice(0, 50).map((o) => ({
    date: o.invoice_date,
    site: o.account_key ?? "-",
    qty: o.quantity != null ? Number(o.quantity) : null,
    unitPrice: o.unit_price != null ? Number(o.unit_price) : null,
    extended: o.extended_price != null ? Number(o.extended_price) : null,
    billedUnit: o.billed_unit,
    weightLineValue: o.weight_line_value != null ? Number(o.weight_line_value) : null,
  }));

  // bySite: aggregate the full observation set.
  type SiteAgg = { site: string; lines: number; spend: number; lastPaid: number | null; lastBuy: string | null };
  const bySiteMap = new Map<string, SiteAgg>();
  for (const o of observations) {
    const key = o.account_key ?? "-";
    let entry = bySiteMap.get(key);
    if (!entry) {
      entry = { site: key, lines: 0, spend: 0, lastPaid: null, lastBuy: null };
      bySiteMap.set(key, entry);
    }
    entry.lines += 1;
    entry.spend += Number(o.extended_price ?? 0);
    // observations are sorted desc; the first (= newest) for each
    // site wins for lastBuy + lastPaid.
    if (!entry.lastBuy && o.invoice_date) {
      entry.lastBuy = o.invoice_date;
      entry.lastPaid = o.unit_price != null ? Number(o.unit_price) : null;
    }
  }
  const bySite = Array.from(bySiteMap.values()).sort((a, b) => b.spend - a.spend);

  // Siblings: other pr_vendor_items linked to this ingredient. One
  // page of top-50 by annual spend keeps the panel fast; the master
  // page still shows the full list.
  type Sibling = {
    id: string;
    name: string;
    vendor: string;
    pack: string | null;
    perBase: number | null;
    perBaseUom: string | null;
    usd12m: number;
  };
  let siblings: Sibling[] = [];
  if (it.ingredient_id) {
    const { data: sibRaw, error: sibErr } = await client
      .from("pr_vendor_items")
      .select(
        "id,name,vendor_id,pack_text,pack_qty,pack_size,pack_uom,price_estimate,usd_12m"
      )
      .eq("ingredient_id", it.ingredient_id)
      .in("status", ["active", "resale"])
      .neq("id", it.id)
      .order("usd_12m", { ascending: false, nullsFirst: false })
      .limit(50);
    if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 });

    const sibRows = (sibRaw ?? []) as Array<{
      id: string;
      name: string;
      vendor_id: string;
      pack_text: string | null;
      pack_qty: number | null;
      pack_size: number | null;
      pack_uom: string | null;
      price_estimate: { per_base?: number | null; base_uom?: string | null } | null;
      usd_12m: number | null;
    }>;
    const vendorIds = Array.from(new Set(sibRows.map((r) => r.vendor_id)));
    const vendorNameById = new Map<string, string>();
    if (vendorIds.length > 0) {
      const { data: vRows } = await client
        .from("pr_vendors")
        .select("id,name")
        .in("id", vendorIds);
      for (const v of (vRows ?? []) as Array<{ id: string; name: string }>) {
        vendorNameById.set(v.id, v.name);
      }
    }
    siblings = sibRows.map((r) => {
      const normalizedPack =
        r.pack_qty != null && r.pack_size != null && r.pack_uom
          ? Number(r.pack_qty) === 1
            ? `${r.pack_size} ${r.pack_uom}`
            : `${r.pack_qty}/${r.pack_size} ${r.pack_uom}`
          : r.pack_text ?? null;
      const pe = r.price_estimate ?? null;
      const perBase =
        pe && pe.per_base != null && Number.isFinite(Number(pe.per_base)) ? Number(pe.per_base) : null;
      return {
        id: r.id,
        name: r.name,
        vendor: vendorNameById.get(r.vendor_id) ?? r.vendor_id,
        pack: normalizedPack,
        perBase,
        perBaseUom: pe?.base_uom ?? null,
        usd12m: Number(r.usd_12m ?? 0),
      };
    });
  }

  // Variants: other OCR spellings folded under the same vendor SKU.
  // Twin logic lives on (vendor_id, item_number_norm); we return the
  // distinct names seen plus a count of lines each.
  type Variant = { name: string; count: number };
  let variants: Variant[] = [];
  if (it.item_number_norm) {
    const { data: twinRows, error: twinErr } = await client
      .from("pr_vendor_items")
      .select("id,name,lines_12m")
      .eq("vendor_id", it.vendor_id)
      .eq("item_number_norm", it.item_number_norm)
      .neq("id", it.id);
    if (twinErr) return NextResponse.json({ error: twinErr.message }, { status: 500 });
    const byName = new Map<string, number>();
    for (const t of (twinRows ?? []) as Array<{ name: string; lines_12m: number | null }>) {
      const n = String(t.name ?? "").trim();
      if (!n) continue;
      byName.set(n, (byName.get(n) ?? 0) + Number(t.lines_12m ?? 0));
    }
    variants = Array.from(byName.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  return NextResponse.json({
    catchWeight: it.catch_weight,
    invoiceLines,
    bySite,
    siblings,
    variants,
  });
}
