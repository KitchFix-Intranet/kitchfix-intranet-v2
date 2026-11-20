// /api/invoices/files/[id]
//   PATCH - rotate the shown page (stored as rotation; the file is
//           unchanged on disk) or reorder (sort_order).

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, getFileById } from "@/lib/invoices/draftLoad";
import { patchFile } from "@/lib/invoices/draftWrite";
import { pickSortOrder } from "@/lib/invoices/sortOrder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const VALID_ROT = new Set([0, 90, 180, 270]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const body = (await req.json().catch(() => null)) as { rotation?: unknown; sort_order?: unknown } | null;
  if (!body) return new Response(null, { status: 400 });

  // Train 2b correction 4.3 / fix-before-push #8: whole-number
  // sort_order via the shared pickSortOrder helper. A bad input
  // keeps sort_order untouched (sentinel -1 is never a valid stored
  // value, so a return of -1 means "do not patch sort_order").
  const patchBody: { rotation?: 0 | 90 | 180 | 270; sort_order?: number } = {};
  if (typeof body.rotation === "number" && VALID_ROT.has(body.rotation)) {
    patchBody.rotation = body.rotation as 0 | 90 | 180 | 270;
  }
  const picked = pickSortOrder(body.sort_order, -1);
  if (picked >= 0) patchBody.sort_order = picked;
  if (Object.keys(patchBody).length === 0) return new Response(null, { status: 400 });

  const row = await patchFile(sb, draftId, fileId, patchBody);
  if (!row) return new Response(null, { status: 500 });
  return NextResponse.json({
    file: {
      id: row.id,
      draft_id: row.draft_id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      page_count: row.page_count,
      sort_order: row.sort_order,
      rotation: row.rotation,
      created_at: row.created_at,
      removed_at: row.removed_at,
    },
  });
}
