// /api/invoices/latest-sent
//   GET ?site=<slug> - the five newest counting invoices for the site.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { loadLatestSent } from "@/lib/invoices/latestSent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const site = url.searchParams.get("site");

  const open = await openInvoiceApi({ as, write: false, site: { slugOrKey: site, required: true } });
  if (!open.ok) return open.response;
  const { sb, accountKey } = open;
  if (!accountKey) return NextResponse.json({ rows: [] });

  const rows = await loadLatestSent(sb, accountKey, 5);
  return NextResponse.json({ rows });
}
