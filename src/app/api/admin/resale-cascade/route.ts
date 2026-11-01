// POST | GET /api/admin/resale-cascade
//
// One-time cleanup for the pre-S1 state where a Retail ingredient
// could carry linked items still at status='active'. Dry-run is the
// default; writes only happen with ?dryRun=0.
//
// What it does:
//   - Finds every pr_vendor_items row where
//       pr_ingredients.resale = true AND
//       pr_vendor_items.link_status = 'confirmed' AND
//       pr_vendor_items.status = 'active'
//     and flips status -> 'resale'. Writes one pr_events row per
//     touched item with kind='status_set' and via='admin_resale_cascade'.
//
// What it DOES NOT do:
//   - It never cascades to proposed links. A proposal is the matcher's
//     guess; confirmItems (the Review-queue path) is responsible for
//     landing those correctly as resale when the target is Retail.
//   - It never touches 'duplicate' or 'archived' - those are states
//     the row chose for its own reasons.
//   - It never flips 'resale' back to 'active'. Items currently
//     status='resale' whose ingredient is NOT Retail are REPORTED but
//     not changed; Kevin decides whether those are deliberate.
//
// Idempotent: a second run finds no rows to change.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { getMatcherCoverage } from "@/lib/matcher/coverage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TargetRow = {
  id: string;
  name: string;
  item_number: string | null;
  usd_12m: number | null;
  status: string;
  vendor_id: string;
  ingredient_id: string;
};

async function run(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  // Dry-run is the default. Writes require explicit ?dryRun=0.
  const dryRun = req.nextUrl.searchParams.get("dryRun") !== "0";
  const client = serviceClient();

  // 1) Load every Retail ingredient id. Small set; one page is enough.
  const { data: retailRows, error: retailErr } = await client
    .from("pr_ingredients")
    .select("id,name")
    .eq("resale", true)
    .eq("status", "active");
  if (retailErr) return NextResponse.json({ error: retailErr.message }, { status: 500 });
  const retailIngredients = (retailRows ?? []) as Array<{ id: string; name: string }>;
  const retailIngredientIds = retailIngredients.map((r) => r.id);
  const ingredientNameById = new Map(retailIngredients.map((r) => [r.id, r.name]));

  // 2) Load every confirmed, currently-active item that points at one
  //    of those ingredients.
  const toMove: TargetRow[] = [];
  if (retailIngredientIds.length > 0) {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await client
        .from("pr_vendor_items")
        .select("id,name,item_number,usd_12m,status,vendor_id,ingredient_id")
        .in("ingredient_id", retailIngredientIds)
        .eq("link_status", "confirmed")
        .eq("status", "active")
        .range(from, from + PAGE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const chunk = (data ?? []) as TargetRow[];
      toMove.push(...chunk);
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  // 3) Load the mismatched rows (reporting only): item status='resale'
  //    while the item's ingredient is NOT a Retail ingredient. Those
  //    may be deliberate; Kevin rules on them.
  type MismatchRow = TargetRow & { ingredient_resale: boolean | null };
  const mismatched: MismatchRow[] = [];
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await client
        .from("pr_vendor_items")
        .select("id,name,item_number,usd_12m,status,vendor_id,ingredient_id")
        .eq("status", "resale")
        .eq("link_status", "confirmed")
        .not("ingredient_id", "is", null)
        .range(from, from + PAGE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const chunk = (data ?? []) as TargetRow[];
      for (const r of chunk) {
        if (!retailIngredientIds.includes(r.ingredient_id)) {
          mismatched.push({ ...r, ingredient_resale: false });
        }
      }
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  // 4) Vendor-name enrichment for the report.
  const vendorIds = Array.from(
    new Set([...toMove.map((r) => r.vendor_id), ...mismatched.map((r) => r.vendor_id)])
  );
  const vendorNameById = new Map<string, string>();
  if (vendorIds.length > 0) {
    const { data: vRows } = await client.from("pr_vendors").select("id,name").in("id", vendorIds);
    for (const v of (vRows ?? []) as Array<{ id: string; name: string }>) {
      vendorNameById.set(v.id, v.name);
    }
  }

  const totalUsd = toMove.reduce((s, r) => s + Number(r.usd_12m ?? 0), 0);
  const mismatchedUsd = mismatched.reduce((s, r) => s + Number(r.usd_12m ?? 0), 0);

  // 5) Coverage before. In dry-run this is also the "if applied" number
  //    we show the user ("after") - items leaving status='active' drop
  //    out of the matcher's denominator, so coverage rises.
  const coverageBefore = await getMatcherCoverage(client);

  const toMoveRows = toMove.map((r) => ({
    id: r.id,
    item: r.name,
    vendor: vendorNameById.get(r.vendor_id) ?? r.vendor_id,
    itemNumber: r.item_number,
    ingredient: ingredientNameById.get(r.ingredient_id) ?? r.ingredient_id,
    usd12m: Number(r.usd_12m ?? 0),
    from: r.status,
    to: "resale",
  }));
  toMoveRows.sort((a, b) => b.usd12m - a.usd12m);

  const mismatchedRows = mismatched.map((r) => ({
    id: r.id,
    item: r.name,
    vendor: vendorNameById.get(r.vendor_id) ?? r.vendor_id,
    itemNumber: r.item_number,
    ingredientId: r.ingredient_id,
    usd12m: Number(r.usd_12m ?? 0),
    status: r.status,
    note: "item is resale but its ingredient is not Retail",
  }));
  mismatchedRows.sort((a, b) => b.usd12m - a.usd12m);

  if (dryRun) {
    // Coverage "after" prediction: subtract the to-move spend from the
    // denominator and the covered total alike (they are confirmed, so
    // currently covered). Removes equal amounts from num + den.
    const newTotal = coverageBefore.totalUsd - totalUsd;
    const newCovered = coverageBefore.coveredUsd - totalUsd;
    const newPct = newTotal > 0 ? (newCovered / newTotal) * 100 : 0;
    return NextResponse.json({
      dryRun: true,
      count: toMoveRows.length,
      totalUsd,
      mismatched: {
        count: mismatchedRows.length,
        usd: mismatchedUsd,
        rows: mismatchedRows,
      },
      coverage: {
        before: {
          totalUsd: coverageBefore.totalUsd,
          coveredUsd: coverageBefore.coveredUsd,
          pct: coverageBefore.pct,
        },
        after: {
          totalUsd: newTotal,
          coveredUsd: newCovered,
          pct: newPct,
        },
      },
      rows: toMoveRows,
    });
  }

  // Apply mode. Per-row UPDATE with a race guard; one pr_events row
  // per touched item.
  let moved = 0;
  const errors: string[] = [];
  for (const r of toMove) {
    const { error: upErr } = await client
      .from("pr_vendor_items")
      .update({ status: "resale" })
      .eq("id", r.id)
      .eq("status", "active")
      .eq("link_status", "confirmed");
    if (upErr) {
      errors.push(`${r.id}: ${upErr.message}`);
      continue;
    }
    moved += 1;
    await client.from("pr_events").insert({
      entity_type: "vendor_item",
      entity_id: r.id,
      kind: "status_set",
      before: { status: "active" },
      after: { status: "resale", via: "admin_resale_cascade", ingredient_id: r.ingredient_id },
      actor: gate.email,
    });
  }

  const coverageAfter = await getMatcherCoverage(client);
  return NextResponse.json({
    dryRun: false,
    moved,
    totalUsd,
    errors,
    mismatched: {
      count: mismatchedRows.length,
      usd: mismatchedUsd,
      rows: mismatchedRows,
    },
    coverage: {
      before: {
        totalUsd: coverageBefore.totalUsd,
        coveredUsd: coverageBefore.coveredUsd,
        pct: coverageBefore.pct,
      },
      after: {
        totalUsd: coverageAfter.totalUsd,
        coveredUsd: coverageAfter.coveredUsd,
        pct: coverageAfter.pct,
      },
    },
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
