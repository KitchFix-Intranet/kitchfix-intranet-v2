// N13 R6: Spend by site + Invoice wording for the item panel. Lazy
// fetched on first expand of either closed row inside ItemPanelById;
// one call returns both lists so the two rows share the fetch.
//
// Read-only, owner-gated, pr_* only - mirrors the sibling
// /api/vendor-items/[id]/status.
//
// The two queries are exactly what VendorItemDrawer ran at
// VendorItemDrawer.tsx:97-110 (same 1000-row observations cap); the
// per-site aggregation that used to live in the drawer's render path
// now runs server-side so the client renderer stays dumb.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { COUNTABLE_OBSERVATIONS_VIEW, applyCountableFilter } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Alias = { description: string; count: number; last_seen: string | null };
type ObsRow = {
  account_key: string;
  invoice_date: string | null;
  unit_price: number | null;
  quantity: number | null;
  extended_price: number | null;
};
type Site = {
  account_key: string;
  lines: number;
  last_date: string | null;
  last_price: number | null;
  dollars: number;
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id must be a uuid" }, { status: 400 });

  const client = serviceClient();

  const [aliasesRes, obsRes] = await Promise.all([
    client
      .from("pr_vendor_item_aliases")
      .select("description,count,last_seen")
      .eq("vendor_item_id", id)
      .order("count", { ascending: false }),
    applyCountableFilter(
      client
        .from(COUNTABLE_OBSERVATIONS_VIEW)
        .select("account_key,invoice_date,unit_price,quantity,extended_price")
        .eq("vendor_item_id", id)
        .order("invoice_date", { ascending: false })
        .limit(1000),
    ),
  ]);
  if (aliasesRes.error) return NextResponse.json({ error: aliasesRes.error.message }, { status: 500 });
  if (obsRes.error) return NextResponse.json({ error: obsRes.error.message }, { status: 500 });

  const aliases = (aliasesRes.data ?? []) as Alias[];

  // Per-site aggregation lifted from VendorItemDrawer.tsx:144-154 so
  // the client never recomputes.
  const bySite = new Map<string, Site>();
  for (const o of (obsRes.data ?? []) as ObsRow[]) {
    const key = o.account_key;
    const dollars = Number.isFinite(Number(o.extended_price)) ? Number(o.extended_price) : 0;
    const prior = bySite.get(key);
    if (!prior) {
      bySite.set(key, {
        account_key: key,
        lines: 1,
        last_date: o.invoice_date,
        last_price: o.unit_price != null && Number.isFinite(Number(o.unit_price)) ? Number(o.unit_price) : null,
        dollars,
      });
    } else {
      prior.lines += 1;
      prior.dollars += dollars;
      // Observations are ordered DESC by invoice_date, so the first
      // entry for a site holds the latest date + price.
    }
  }
  const sites: Site[] = Array.from(bySite.values()).sort((a, b) => b.dollars - a.dollars);

  return NextResponse.json({ aliases, sites });
}
