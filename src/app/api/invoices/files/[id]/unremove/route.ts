// /api/invoices/files/[id]/unremove
//   POST - clear removed_at. The counterpart to /remove, used by
//   the Undo toast after "Remove the file". No DELETE on this table
//   (§5): remove sets removed_at, unremove clears it.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, getFileById } from "@/lib/invoices/draftLoad";
import { unremoveFile } from "@/lib/invoices/draftWrite";
import { toFileView } from "@/lib/invoices/draftLoad";

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
  if (draft.status !== "draft") return NextResponse.json({ error: "frozen" }, { status: 409 });

  const existing = await getFileById(sb, fileId, draftId);
  if (!existing) return new Response(null, { status: 404 });
  // Nothing to do if the file is already live.
  if (existing.removed_at == null) return NextResponse.json({ file: toFileView(existing) });

  const row = await unremoveFile(sb, draftId, fileId);
  if (!row) return new Response(null, { status: 500 });
  return NextResponse.json({ file: toFileView(row) });
}
