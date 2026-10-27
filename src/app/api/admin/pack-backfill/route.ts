import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { estimatePerUnit } from "@/lib/ingredients/estimate";

export const dynamic = "force-dynamic";

// One-time (and idempotent) backfill of pack_qty / pack_size / pack_uom /
// pack_state / price_estimate on pr_vendor_items for food items in the
// active/resale buckets. Reads pr_vendor_catalog (same catalog join as
// the review loader) and the latest pr_price_observations unit_price per
// item for the case-price fallback.
//
// Cursor-based: each POST processes up to BATCH items starting at
// `offset`, returning the next offset + a counts summary. The client
// loops until `done=true`. This keeps us well inside Vercel's serverless
// timeout.
//
// Never writes to a row whose pack_override IS NOT NULL - that's a
// human override we must not clobber. Fully idempotent: re-running with
// the same inputs produces the same writes.

const BATCH = 400;

type Item = {
  id: string;
  vendor_id: string;
  item_number_norm: string | null;
  pack_text: string | null;
  catch_weight: boolean;
  pack_override: unknown;
};

type CatalogRow = {
  vendor_id: string;
  item_number_norm: string;
  pack_text: string | null;
  catalog_price: number | null;
};

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { offset?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const offset = Math.max(0, Number(body.offset ?? 0));

  const client = serviceClient();

  // Load one batch of items. Only food, active/resale, override-free.
  // Ordered by id so paging is stable across invocations.
  const { data: itemsData, error: itemsErr } = await client
    .from("pr_vendor_items")
    .select("id,vendor_id,item_number_norm,pack_text,catch_weight,pack_override")
    .eq("is_food", true)
    .in("status", ["active", "resale"])
    .is("pack_override", null)
    .order("id", { ascending: true })
    .range(offset, offset + BATCH - 1);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  const items = (itemsData ?? []) as Item[];

  if (items.length === 0) {
    return NextResponse.json({
      ok: true,
      done: true,
      processed: 0,
      nextOffset: offset,
      counts: { ok: 0, check: 0, none: 0, skipped: 0 },
    });
  }

  // Catalog batch: one query per vendor on the ids in this batch.
  // Mirrors the review loader's pattern.
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

  // Latest valid unit_price per item (for billed fallback + catch-weight).
  const latestByItem = new Map<string, number>();
  {
    const ids = items.map((it) => it.id);
    const page = 1000;
    let from = 0;
    // We only need observations for items in this batch; keep ordered
    // desc by invoice_date so first-seen wins per item.
    for (;;) {
      const { data: obsData, error: obsErr } = await client
        .from("pr_price_observations")
        .select("vendor_item_id,unit_price,invoice_date")
        .in("vendor_item_id", ids)
        .is("excluded_reason", null)
        .not("unit_price", "is", null)
        .order("invoice_date", { ascending: false, nullsFirst: false })
        .range(from, from + page - 1);
      if (obsErr) return NextResponse.json({ error: obsErr.message }, { status: 500 });
      const chunk = (obsData ?? []) as Array<{
        vendor_item_id: string;
        unit_price: number | null;
        invoice_date: string | null;
      }>;
      for (const o of chunk) {
        if (latestByItem.has(o.vendor_item_id)) continue;
        if (o.unit_price == null) continue;
        latestByItem.set(o.vendor_item_id, Number(o.unit_price));
      }
      if (chunk.length < page) break;
      from += page;
    }
  }

  // Process + write per item. The guard `.is("pack_override", null)` on
  // the UPDATE is defensive; a parallel human override during the loop
  // would be respected.
  const counts = { ok: 0, check: 0, none: 0, skipped: 0 };
  for (const it of items) {
    if (it.pack_override !== null) {
      counts.skipped += 1;
      continue;
    }
    const key = it.item_number_norm ? `${it.vendor_id}#${it.item_number_norm}` : null;
    const cat = key ? catalogByKey.get(key) ?? null : null;
    const result = estimatePerUnit({
      pack_text: it.pack_text,
      catch_weight: it.catch_weight,
      latest_unit_price: latestByItem.get(it.id) ?? null,
      catalog_pack_text: cat?.pack_text ?? null,
      catalog_price: cat?.catalog_price != null ? Number(cat.catalog_price) : null,
    });

    const parsed = result.parsed;
    const estimate = result.estimate;
    // Map confidence -> pack_state. Existing CHECK constraint only
    // allows ('ok','check','none'); we stay within those three. The
    // "override" discriminator is pack_override IS NOT NULL, which
    // this backfill never produces.
    const packState =
      estimate.confidence === "high" ? "ok" : estimate.confidence === "low" ? "check" : "none";

    const { error: upErr } = await client
      .from("pr_vendor_items")
      .update({
        pack_qty: parsed.qty,
        pack_size: parsed.size,
        pack_uom: parsed.uom,
        pack_state: packState,
        price_estimate: estimate,
      })
      .eq("id", it.id)
      .is("pack_override", null);
    if (upErr) {
      // Non-fatal: log in counts and continue. One row's parse
      // oddity shouldn't abort the batch.
      counts.skipped += 1;
      continue;
    }
    if (packState === "ok") counts.ok += 1;
    else if (packState === "check") counts.check += 1;
    else counts.none += 1;
  }

  const done = items.length < BATCH;
  return NextResponse.json({
    ok: true,
    done,
    processed: items.length,
    nextOffset: offset + items.length,
    counts,
  });
}
