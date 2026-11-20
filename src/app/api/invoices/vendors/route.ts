// /api/invoices/vendors
//   GET ?site=<slug>&q=<text> - vendor picker payload.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { searchVendors } from "@/lib/invoices/vendorPicker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const site = url.searchParams.get("site");
  // q is user text; cap at 80 so a pasted paragraph cannot widen
  // the search (mirrors train-1 fix #8).
  const qRaw = (url.searchParams.get("q") ?? "").trim().slice(0, 80);

  // Read-only route.
  const open = await openInvoiceApi({ as, write: false, site: { slugOrKey: site, required: true } });
  if (!open.ok) return open.response;
  const { sb, accountKey } = open;
  if (!accountKey) return NextResponse.json({ vendors: [] });

  const rows = await searchVendors({ sb, accountKey, q: qRaw || null, limit: 50 });
  return NextResponse.json({ vendors: rows });
}
