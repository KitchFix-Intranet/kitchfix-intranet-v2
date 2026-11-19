// /api/invoices/files/[id]/view
//   GET - returns a 60-second signed URL for the stored file.
//
// Correction 5: the server builds the storage_path. The browser
// sends draft_id + file_id and nothing else.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, getFileById } from "@/lib/invoices/draftLoad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "invoice-files";
const SIGNED_URL_SECS = 60;

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: fileId } = await params;
  if (!isUuid(fileId)) return new Response(null, { status: 400 });

  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const draftId = url.searchParams.get("draft");
  if (!isUuid(draftId)) return new Response(null, { status: 400 });

  // View is read-only; owner preview may use it.
  const open = await openInvoiceApi({ as, write: false });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });

  const file = await getFileById(sb, fileId, draftId);
  if (!file || file.removed_at !== null) return new Response(null, { status: 404 });

  // Signed URL. The storage_path is read from the DB (server-built);
  // the client cannot steer the path.
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(file.storage_path, SIGNED_URL_SECS);
  if (error || !data?.signedUrl) return NextResponse.json({ error: "sign_failed" }, { status: 500 });

  return NextResponse.json({ url: data.signedUrl, expires_in: SIGNED_URL_SECS, mime_type: file.mime_type });
}
