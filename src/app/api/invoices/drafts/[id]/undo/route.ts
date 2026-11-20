// /api/invoices/drafts/[id]/undo
//   POST - clears status='discarded' back to 'draft'.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, toDraftView } from "@/lib/invoices/draftLoad";
import { undoDiscardDraft } from "@/lib/invoices/draftWrite";

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
  if (existing.status === "draft") {
    // Idempotency: already a draft.
    return NextResponse.json({ draft: toDraftView(existing) });
  }
  if (existing.status === "sent") {
    return NextResponse.json({ error: "cannot_undo_sent" }, { status: 409 });
  }

  const row = await undoDiscardDraft(sb, ownerEmail, draftId);
  if (!row) return new Response(null, { status: 500 });
  return NextResponse.json({ draft: toDraftView(row) });
}
