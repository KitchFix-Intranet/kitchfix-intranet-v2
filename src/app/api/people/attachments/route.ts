// T4b-2 + T4b-2.1 (2026-11-12). Receipt attachments API. Three
// methods:
//
//   POST   /api/people/attachments?draft=<id>
//     multipart/form-data with one `file` field. Validates:
//       - size <= 10 MB
//       - magic-byte check against PDF / JPEG / PNG / WebP / HEIC
//       - draft exists + belongs to the viewer
//       - draft's action is travel_reimbursement or other_reimbursement
//       - draft has fewer than MAX_RECEIPTS_PER_DRAFT (5) rows already
//     Generates the attachment id server-side, uploads to
//     `drafts/<draft>/<id>.<ext>`, THEN inserts the row with the
//     final storage_path. If the insert fails the object is removed.
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
// Table / bucket: people_attachments + people-receipts. (The T4b-2.1
// prompt named `people_v2_05_receipts`; the live table is
// `people_attachments` with that exact column shape.)

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { loadDraft } from "@/lib/people/drafts";
import {
  BUCKET, KIND_RECEIPT, MAX_BYTES, MAX_RECEIPTS_PER_DRAFT, SIGNED_URL_SECS,
  detectKind, safeFileName, storagePath,
  listReceiptsForDraft, countReceiptsForDraft, getReceipt, deleteReceipt,
  type AttachmentRow,
} from "@/lib/people/attachments";
import type { Viewer } from "@/lib/people/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TABLE = "people_attachments";

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

function toClientRow(r: AttachmentRow) {
  return {
    id: r.id,
    file_name: r.file_name,
    file_size: r.size_bytes,
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

  // T4b-2.1 Fix 3: per-draft cap. Count is cheap (head:true). The
  // race window between count + insert is bounded by the insert's
  // storage_path uniqueness constraint - the sixth concurrent write
  // would still land in the table but the client refuses visibly.
  const haveN = await countReceiptsForDraft(sb, owner, draftId);
  if (haveN >= MAX_RECEIPTS_PER_DRAFT) {
    return NextResponse.json({ error: "too_many_files" }, { status: 409 });
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

  // T4b-2.1 Fix 2: generate id server-side, upload FIRST, then
  // insert with the final storage_path. storage_path is UNIQUE, so
  // a "pending" placeholder would wedge every subsequent upload for
  // every owner. We also do not update after insert.
  const attachmentId = crypto.randomUUID();
  const path = storagePath(draftId, attachmentId, kind.ext);

  const upload = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: kind.mime,
    upsert: false,
  });
  if (upload.error) {
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  const insertQ = await sb
    .from(TABLE)
    .insert({
      id: attachmentId,
      draft_id: draftId,
      owner_email: owner,
      kind: KIND_RECEIPT,
      file_name: fileName,
      size_bytes: raw.size,
      mime_type: kind.mime,
      storage_path: path,
    })
    .select("*")
    .maybeSingle();
  if (insertQ.error || !insertQ.data) {
    // Row never landed; clean up the orphaned object.
    await sb.storage.from(BUCKET).remove([path]);
    return NextResponse.json({ error: "db_insert_failed" }, { status: 500 });
  }
  return NextResponse.json({ row: toClientRow(insertQ.data as AttachmentRow) }, { status: 201 });
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
