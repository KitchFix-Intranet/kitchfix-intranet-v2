// T4b-2 (2026-11-14). Receipt attachments for Travel + Other
// reimbursement. Owner-scoped: every read/write/delete filters on
// owner_email so one viewer can never see another viewer's draft
// receipts. The Storage bucket `people-receipts` uses paths of the
// shape `${owner_email}/${draft_id}/${file_id}.${ext}` so the
// same owner filter applies at the object layer too.
//
// Table `people_attachments`:
//   id              uuid           PK, generated
//   draft_id        uuid           FK -> people_drafts.id (on delete cascade)
//   owner_email     text           lower-cased work_email of the draft owner
//   file_name       text           uploader's filename (sanitised)
//   file_size       bigint         bytes
//   mime_type       text           SERVER-VALIDATED, not the browser claim
//   storage_path    text           bucket-relative path (owner/draft/id.ext)
//   created_at      timestamptz    default now()
//
// Nothing in this file writes to `submissions` or sends anything.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AttachmentRow {
  id: string;
  draft_id: string;
  owner_email: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  created_at: string;
}

export const BUCKET = "people-receipts" as const;

// Signed-URL TTL. Short so a leaked URL cannot be re-used.
export const SIGNED_URL_SECS = 60;

export const MAX_BYTES = 10 * 1024 * 1024;

// Magic-byte prefixes for the MIME types we accept. Anything that
// does not match is rejected with 415 in the route - the browser's
// claimed MIME is not trusted.
const MAGIC: Array<{ mime: string; ext: string; match: (buf: Uint8Array) => boolean }> = [
  { mime: "application/pdf", ext: "pdf", match: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: "image/jpeg",      ext: "jpg", match: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: "image/png",       ext: "png", match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
  { mime: "image/webp",      ext: "webp", match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  // HEIC: "ftypheic" / "ftypheix" / "ftypmif1" after a 4-byte size.
  { mime: "image/heic",      ext: "heic", match: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && (
    (b[8] === 0x68 && b[9] === 0x65 && b[10] === 0x69 && (b[11] === 0x63 || b[11] === 0x78))
    || (b[8] === 0x6d && b[9] === 0x69 && b[10] === 0x66 && b[11] === 0x31)
  ) },
];

export interface DetectedKind { mime: string; ext: string }
export function detectKind(bytes: Uint8Array): DetectedKind | null {
  for (const m of MAGIC) {
    if (bytes.length >= 16 && m.match(bytes)) return { mime: m.mime, ext: m.ext };
  }
  return null;
}

// File name sanitiser. Strips path separators, collapses whitespace,
// caps at 120 chars. Preserves the original extension when it looks
// safe; otherwise falls back to the detected one.
export function safeFileName(raw: string, fallbackExt: string): string {
  const base = (raw ?? "").replace(/[/\\]/g, "").replace(/\s+/g, " ").trim();
  if (!base) return `receipt.${fallbackExt}`;
  const capped = base.length > 120 ? base.slice(0, 120) : base;
  return capped.includes(".") ? capped : `${capped}.${fallbackExt}`;
}

export function storagePath(ownerEmail: string, draftId: string, attachmentId: string, ext: string): string {
  const safeOwner = ownerEmail.toLowerCase().replace(/[^a-z0-9._@-]+/g, "_");
  return `${safeOwner}/${draftId}/${attachmentId}.${ext}`;
}

// List all receipts for a draft. Owner filter prevents cross-draft
// leakage even if a tampered draft_id is passed.
export async function listReceiptsForDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<AttachmentRow[]> {
  const q = await sb
    .from("people_attachments")
    .select("*")
    .eq("owner_email", ownerEmail)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: true });
  if (q.error) return [];
  return (q.data ?? []) as AttachmentRow[];
}

export async function getReceipt(
  sb: SupabaseClient,
  ownerEmail: string,
  id: string,
): Promise<AttachmentRow | null> {
  const q = await sb
    .from("people_attachments")
    .select("*")
    .eq("owner_email", ownerEmail)
    .eq("id", id)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as AttachmentRow;
}

// Delete all receipts for one draft. Called from the discard-draft
// flow in /api/people/drafts BEFORE the draft row itself goes - the
// FK has ON DELETE CASCADE but the Storage bucket does not, so we
// clean up objects explicitly.
export async function deleteDraftReceipts(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<void> {
  const rows = await listReceiptsForDraft(sb, ownerEmail, draftId);
  if (rows.length === 0) return;
  const paths = rows.map((r) => r.storage_path);
  const { error: storageErr } = await sb.storage.from(BUCKET).remove(paths);
  if (storageErr) throw new Error(storageErr.message);
  const { error: dbErr } = await sb
    .from("people_attachments")
    .delete()
    .eq("owner_email", ownerEmail)
    .eq("draft_id", draftId);
  if (dbErr) throw new Error(dbErr.message);
}

// Delete one receipt (both object + row). Used by the DELETE handler.
export async function deleteReceipt(
  sb: SupabaseClient,
  ownerEmail: string,
  id: string,
): Promise<boolean> {
  const row = await getReceipt(sb, ownerEmail, id);
  if (!row) return false;
  const { error: storageErr } = await sb.storage.from(BUCKET).remove([row.storage_path]);
  // If the object is missing we still delete the row (storage drift
  // would be worse than a leftover object).
  if (storageErr) { /* swallow intentionally - row still goes below */ }
  const { error: dbErr } = await sb
    .from("people_attachments")
    .delete()
    .eq("owner_email", ownerEmail)
    .eq("id", id);
  if (dbErr) return false;
  return true;
}
