// /api/invoices/uploads
//   POST - returns a signed upload URL for direct-to-bucket upload.
//
// Correction 5: the server builds the storage_path. Browser only
// sends draft_id + the kind-hint it has from the OS (ext). The real
// kind check happens at /api/invoices/files once the bytes land.
//
// Idempotency: the server generates the file_id and the path. The
// client is expected to use them as-is; a repeat upload slot for
// the same (draft, file_id) is not something the client does - but
// if a second POST arrives with no file_id hint, we always mint a
// new slot (gotcha 18: never upsert).

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById } from "@/lib/invoices/draftLoad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "invoice-files";
const MAX_BYTES = 52_428_800; // 50 MB

// ext -> bucket content-type (the actual file is written by the
// browser via the signed URL; this is advisory).
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

interface Body {
  draft_id?: string;
  file_name?: string;
  size_bytes?: number;
  mime_type_hint?: string;
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function extFromName(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || !isUuid(body.draft_id) || !body.file_name || typeof body.size_bytes !== "number") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!(body.size_bytes > 0 && body.size_bytes <= MAX_BYTES)) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const ext = extFromName(body.file_name);
  if (!ext || !EXT_MIME[ext]) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }

  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, body.draft_id);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });
  if (draft.status !== "draft") return NextResponse.json({ error: "frozen" }, { status: 409 });

  const fileId = randomUUID();
  const extForPath = ext === "jpeg" ? "jpg" : ext;
  const storagePath = `drafts/${draft.id}/${fileId}.${extForPath}`;

  const signed = await sb.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (signed.error || !signed.data) {
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  // Known gap (train 2 prompt correction 13): an upload slot that
  // is never finished leaves nothing in the bucket until the browser
  // PUTs - but a PUT with no matching finish will leave a bucket
  // object with no row. Documented; not solved in train 2.
  return NextResponse.json({
    file_id: fileId,
    signed_url: signed.data.signedUrl,
    signed_path: signed.data.path, // bucket-relative path, same as our storage_path
    expires_in: 60 * 60, // Supabase defaults to 2h for upload URLs; the client should PUT promptly
  });
}
