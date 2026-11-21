// GET /api/invoices/sent/[id]/view
//
// Train 3 correction 7: a submission-keyed route, placed under
// /sent/ so a dynamic [id] segment does not sit beside the draft
// /files /uploads siblings.
//
// Returns a 60 s signed URL for the outbound PDF (the
// invoice_files row with kind='outbound' and submission_id=id).
// Scope-checked the same way the list is: the invoice's
// account_key must be in the viewer's scope. Owner preview may
// read.
//
// No signed link is ever written into server HTML.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { signOutboundViewUrl } from "@/lib/invoices/deliverSend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: invoiceId } = await params;
  if (!isUuid(invoiceId)) return new Response(null, { status: 400 });

  const url = new URL(req.url);
  const as = url.searchParams.get("as");

  // View is read-only; owner preview may use it.
  const open = await openInvoiceApi({ as, write: false });
  if (!open.ok) return open.response;
  const { sb, scope } = open;

  // Scope check: the invoice's account_key must be in the
  // viewer's scope. Read only the two columns we need.
  const inv = await sb
    .from("invoice_submissions")
    .select("account_key, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (inv.error || !inv.data) return new Response(null, { status: 404 });
  const data = inv.data as { account_key: string; status: string };
  if (!scope.accountKeys.includes(data.account_key)) return new Response(null, { status: 404 });
  if (data.status === "deleted" || data.status === "corrected" || data.status === "archived") {
    return new Response(null, { status: 404 });
  }

  // Find the outbound file row.
  const file = await sb
    .from("invoice_files")
    .select("id, mime_type")
    .eq("submission_id", invoiceId)
    .eq("kind", "outbound")
    .maybeSingle();
  if (file.error || !file.data) return new Response(null, { status: 404 });

  const signed = await signOutboundViewUrl(sb, (file.data as { id: string }).id);
  if (!signed) return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  return NextResponse.json({ url: signed, expires_in: 60, mime_type: "application/pdf" });
}
