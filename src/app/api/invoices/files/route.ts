// /api/invoices/files
//   POST - finish an upload. Server downloads the stored bytes from
//   the bucket, runs the magic-byte check, SHA-256s them, counts PDF
//   pages (time-limited; page_count is null on failure for a good
//   PDF per correction 6), and inserts the invoice_files row.
//
// Correction 5: the server builds storage_path from (draft_id, file_id).
// The body carries no path at all.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, listFilesForDraft, liveFilesForOwner } from "@/lib/invoices/draftLoad";
import { insertFile } from "@/lib/invoices/draftWrite";
import { detectKind } from "@/lib/invoices/fileKind";
import { sha256Hex } from "@/lib/invoices/fileSha";
import { pdfPageCount } from "@/lib/invoices/pdfPages";
import { pickSortOrder } from "@/lib/invoices/sortOrder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "invoice-files";
const MAX_BYTES = 52_428_800;
const PDF_PARSE_TIMEOUT_MS = 8_000;

const EXT_FROM_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

interface Body {
  draft_id?: string;
  file_id?: string;
  sort_order?: number;
  file_name?: string; // the browser's display name (sanitised server-side)
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function safeFileName(raw: string | undefined, fallbackExt: string): string {
  const base = (raw ?? "").replace(/[/\\]/g, "").replace(/\s+/g, " ").trim();
  if (!base) return `invoice.${fallbackExt}`;
  const capped = base.length > 120 ? base.slice(0, 120) : base;
  return capped.includes(".") ? capped : `${capped}.${fallbackExt}`;
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || !isUuid(body.draft_id) || !isUuid(body.file_id)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, body.draft_id);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });
  if (draft.status !== "draft") return NextResponse.json({ error: "frozen" }, { status: 409 });

  // The server builds the storage path. The path may carry any of
  // the supported extensions; we try them in order against the
  // bucket.
  let bytes: Uint8Array | null = null;
  let storagePath: string | null = null;
  for (const ext of ["pdf", "jpg", "jpeg", "png", "webp"]) {
    const candidate = `drafts/${draft.id}/${body.file_id}.${ext}`;
    const dl = await sb.storage.from(BUCKET).download(candidate);
    if (!dl.error && dl.data) {
      const ab = await dl.data.arrayBuffer();
      bytes = new Uint8Array(ab);
      storagePath = candidate;
      break;
    }
  }
  if (!bytes || !storagePath) {
    return NextResponse.json({ error: "no_upload_found" }, { status: 404 });
  }

  // Re-measure size and re-check the kind from the real first bytes.
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    await sb.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const kind = detectKind(bytes);
  if (!kind.kind) {
    await sb.storage.from(BUCKET).remove([storagePath]);
    if (kind.unaccepted === "heic") {
      return NextResponse.json({ error: "heic_not_supported" }, { status: 415 });
    }
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }

  // Train 2b correction 4.4: the storage path's ending does not
  // decide the file's kind. The first bytes do. `mime_type` is
  // written from `kind.kind.mime`; `file_name` is given the real
  // extension so the user's download works. No storage move.
  const realExt = EXT_FROM_MIME[kind.kind.mime];

  const sha = sha256Hex(bytes);
  let pageCount: number | null = null;
  if (kind.kind.mime === "application/pdf") {
    pageCount = await pdfPageCount(bytes, PDF_PARSE_TIMEOUT_MS);
    // If parsing failed, keep the file. Row's page_count stays null.
  } else {
    pageCount = 1; // single-image files.
  }

  // Same-file-twice warning. We compute "dupe" across this viewer's
  // live drafts so the client can offer "Use anyway / Remove".
  const myFiles = await liveFilesForOwner(sb, ownerEmail);
  const dupeOf = myFiles.find((f) => f.sha256 === sha && f.draft_id !== draft.id) ?? null;

  // Compute the next sort_order on this draft.
  const existing = await listFilesForDraft(sb, ownerEmail, draft.id);
  const nextOrder = existing.length === 0 ? 0 : Math.max(...existing.map((f) => f.sort_order)) + 1;
  // Train 2b correction 4.3 / fix-before-push #8: shared helper
  // picks the whole-number input or falls back to nextOrder.
  const sortOrder = pickSortOrder(body.sort_order, nextOrder);

  const result = await insertFile(sb, {
    id: body.file_id,
    draftId: draft.id,
    storagePath,
    fileName: safeFileName(body.file_name, realExt),
    mimeType: kind.kind.mime,
    sizeBytes: bytes.length,
    sha256: sha,
    pageCount,
    sortOrder,
    uploadedBy: ownerEmail,
  });

  if (result.status === "err" || !result.row) {
    await sb.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    file: {
      id: result.row.id,
      draft_id: result.row.draft_id,
      file_name: result.row.file_name,
      mime_type: result.row.mime_type,
      size_bytes: result.row.size_bytes,
      page_count: result.row.page_count,
      sort_order: result.row.sort_order,
      rotation: result.row.rotation,
      created_at: result.row.created_at,
      removed_at: result.row.removed_at,
    },
    status: result.status,
    dupe_of: dupeOf ? { draft_id: dupeOf.draft_id, file_id: dupeOf.id } : null,
  }, { status: result.status === "created" ? 201 : 200 });
}
