// /api/invoices/drafts/[id]/discard
//   POST - status='discarded' + discarded_at=now(). Undo clears both.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, toDraftView } from "@/lib/invoices/draftLoad";
import { discardDraft } from "@/lib/invoices/draftWrite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const existing = await getDraftById(sb, ownerEmail, draftId);
  if (!existing) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(existing.account_key)) return new Response(null, { status: 404 });
  if (existing.status !== "draft") {
    // Idempotency: discarding an already-discarded draft returns it.
    return NextResponse.json({ draft: toDraftView(existing) });
  }

  const row = await discardDraft(sb, ownerEmail, draftId);
  if (!row) return new Response(null, { status: 500 });
  return NextResponse.json({ draft: toDraftView(row) });
}
