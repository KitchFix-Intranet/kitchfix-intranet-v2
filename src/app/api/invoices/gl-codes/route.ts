// /api/invoices/gl-codes
//   GET ?site=<slug>&vendor_id=<id> - the site's active codes plus
//   the usual-codes payload for this vendor at this site.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { loadActiveCodesForSite, loadUsualCodes } from "@/lib/invoices/glCodes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const site = url.searchParams.get("site");
  const vendorId = url.searchParams.get("vendor_id");

  const open = await openInvoiceApi({ as, write: false, site: { slugOrKey: site, required: true } });
  if (!open.ok) return open.response;
  const { sb, accountKey } = open;
  if (!accountKey) return NextResponse.json({ codes: [], usual: null });

  const codes = await loadActiveCodesForSite(sb, accountKey);
  const activeSet = new Set(codes.map((c) => c.code));
  const usual = vendorId
    ? await loadUsualCodes(sb, accountKey, vendorId, activeSet)
    : { codes: [], singleCodeFill: null, sampleSize: 0 };

  return NextResponse.json({ codes, usual });
}
