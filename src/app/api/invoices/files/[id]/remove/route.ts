// /api/invoices/files/[id]/remove
//   POST - set removed_at. No DELETE on this table (§5).

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, getFileById } from "@/lib/invoices/draftLoad";
import { removeFile } from "@/lib/invoices/draftWrite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: fileId } = await params;
  if (!isUuid(fileId)) return new Response(null, { status: 400 });

  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const draftId = url.searchParams.get("draft");
  if (!isUuid(draftId)) return new Response(null, { status: 400 });

  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });

  const existing = await getFileById(sb, fileId, draftId);
  if (!existing) return new Response(null, { status: 404 });

  const ok = await removeFile(sb, draftId, fileId);
  if (!ok) return new Response(null, { status: 500 });
  return new Response(null, { status: 204 });
}
