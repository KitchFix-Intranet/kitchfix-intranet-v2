// T4b-2 (2026-11-14). Receipt attachments API. Three methods:
//
//   POST   /api/people/attachments?draft=<id>
//     multipart/form-data with one `file` field. Validates:
//       - size <= 10 MB
//       - magic-byte check against PDF / JPEG / PNG / WebP / HEIC
//       - draft exists + belongs to the viewer
//       - draft's action is travel_reimbursement or other_reimbursement
//     Writes one storage object + one people_attachments row.
//     Returns the row.
//
//   DELETE /api/people/attachments?id=<attachment>
//     Removes the row and the storage object. Owner-filtered.
//
//   GET    /api/people/attachments?draft=<id>
//           &view=1&id=<attachment>
//     Without `id`: returns the list of rows for the draft.
//     With `id` and `view=1`: returns a 60-second signed URL.
//
// Preview guard refuses POST + DELETE under ?as= (viewer.previewOf
// is non-null). GET is allowed under preview so the owner can see
// what already exists without mutating it.
//
// Table / bucket: people_attachments + people-receipts.

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { loadDraft } from "@/lib/people/drafts";
import {
  BUCKET, MAX_BYTES, SIGNED_URL_SECS,
  detectKind, safeFileName, storagePath,
  listReceiptsForDraft, getReceipt, deleteReceipt,
  type AttachmentRow,
} from "@/lib/people/attachments";
import type { Viewer } from "@/lib/people/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Actions that MAY carry receipts. Draft must have one of these
// action_types for POST to succeed.
const RECEIPT_ACTIONS: ReadonlySet<string> = new Set([
  "travel_reimbursement", "other_reimbursement",
]);

async function sessionViewer(asWorkerId: string | null) {
  const gated = await requireOwnerApi();
  if (gated instanceof Response) return { response: gated as Response };
  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, gated.email, asWorkerId, /* isOwner */ true);
  if (!viewer) return { response: new Response(null, { status: 404 }) };
  return { sb, viewer };
}

function ownerEmailFor(viewer: Viewer): string {
  return (viewer.work_email ?? "").trim().toLowerCase();
}

// Lightweight projection of a row for the client.
function toClientRow(r: AttachmentRow) {
  return {
    id: r.id,
    file_name: r.file_name,
    file_size: r.file_size,
    mime_type: r.mime_type,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  const owner = ownerEmailFor(viewer);
  if (!owner) return new Response(null, { status: 400 });

  const draftId = url.searchParams.get("draft");
  const attachmentId = url.searchParams.get("id");
  const wantView = url.searchParams.get("view") === "1";

  if (attachmentId && wantView) {
    const row = await getReceipt(sb, owner, attachmentId);
    if (!row) return new Response(null, { status: 404 });
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_SECS);
    if (error || !data?.signedUrl) return NextResponse.json({ error: "sign_failed" }, { status: 500 });
    return NextResponse.json({ url: data.signedUrl, expires_in: SIGNED_URL_SECS });
  }

  if (!draftId) return NextResponse.json({ rows: [] });
  const draft = await loadDraft(sb, owner, draftId);
  if (!draft) return NextResponse.json({ rows: [] });
  const rows = await listReceiptsForDraft(sb, owner, draftId);
  return NextResponse.json({ rows: rows.map(toClientRow) });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  if (viewer.previewOf !== null) {
    return NextResponse.json({ error: "preview_no_write" }, { status: 403 });
  }
  const owner = ownerEmailFor(viewer);
  if (!owner) return new Response(null, { status: 400 });

  const draftId = url.searchParams.get("draft");
  if (!draftId) return NextResponse.json({ error: "draft_required" }, { status: 400 });
  const draft = await loadDraft(sb, owner, draftId);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  if (!draft.action_type || !RECEIPT_ACTIONS.has(draft.action_type)) {
    return NextResponse.json({ error: "action_not_receipts" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "bad_form" }, { status: 400 });
  const raw = form.get("file");
  if (!(raw instanceof File)) return NextResponse.json({ error: "file_required" }, { status: 400 });
  if (raw.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const bytes = new Uint8Array(await raw.arrayBuffer());
  const kind = detectKind(bytes);
  if (!kind) return NextResponse.json({ error: "unsupported_type" }, { status: 415 });

  const fileName = safeFileName(raw.name, kind.ext);
  // Insert the DB row FIRST with a placeholder storage_path so we
  // have the generated id for the object key. Then upload; if the
  // upload fails we delete the row.
  const insertQ = await sb
    .from("people_attachments")
    .insert({
      draft_id: draftId,
      owner_email: owner,
      file_name: fileName,
      file_size: raw.size,
      mime_type: kind.mime,
      storage_path: "pending",
    })
    .select("*")
    .maybeSingle();
  if (insertQ.error || !insertQ.data) {
    return NextResponse.json({ error: "db_insert_failed" }, { status: 500 });
  }
  const row = insertQ.data as AttachmentRow;
  const path = storagePath(owner, draftId, row.id, kind.ext);

  const upload = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: kind.mime,
    upsert: false,
  });
  if (upload.error) {
    await sb.from("people_attachments").delete().eq("id", row.id).eq("owner_email", owner);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  const patchQ = await sb
    .from("people_attachments")
    .update({ storage_path: path })
    .eq("id", row.id)
    .eq("owner_email", owner)
    .select("*")
    .maybeSingle();
  if (patchQ.error || !patchQ.data) {
    // Object is in bucket but row is broken. Clean up both.
    await sb.storage.from(BUCKET).remove([path]);
    await sb.from("people_attachments").delete().eq("id", row.id).eq("owner_email", owner);
    return NextResponse.json({ error: "db_update_failed" }, { status: 500 });
  }
  return NextResponse.json({ row: toClientRow(patchQ.data as AttachmentRow) }, { status: 201 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  if (viewer.previewOf !== null) {
    return NextResponse.json({ error: "preview_no_write" }, { status: 403 });
  }
  const owner = ownerEmailFor(viewer);
  const id = url.searchParams.get("id");
  if (!owner || !id) return new Response(null, { status: 400 });
  const ok = await deleteReceipt(sb, owner, id);
  if (!ok) return new Response(null, { status: 404 });
  return new Response(null, { status: 204 });
}
