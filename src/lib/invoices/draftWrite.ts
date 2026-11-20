// Server writes for invoice_drafts and invoice_files. No DELETE on
// either table (§5): discard is `status='discarded'`, remove-file is
// `removed_at`. Updates carry an If-Match timestamp so two tabs on
// the same draft do not silently overwrite each other (§6 "the
// newer save wins, the older tab reloads"). gotcha 18 - never
// upsert; always insert with the caller-provided id so a repeat
// returns the existing row if the owner matches.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DraftAnswers, DraftRow, DraftScreen, GlLineDraft, InvoiceKind,
} from "./types";
import { getDraftById } from "./draftLoad";

const DRAFT_COLS =
  "id, account_key, owner_email, vendor_id, type, invoice_number, invoice_date, " +
  "total_amount, gl_breakdown, answers, screen, status, submission_id, " +
  "created_at, updated_at, discarded_at";

export interface CreateDraftInput {
  id: string;                      // browser-generated uuid (idempotency)
  ownerEmail: string;              // lower-cased
  ownerWorkerId: string | null;
  accountKey: string;
  screen: DraftScreen;
}

// Insert with the browser's id. Idempotency rule (correction 3):
//   - If no row exists: insert it; return the inserted row.
//   - If a row with that id exists AND belongs to this owner: return
//     it (the client may have retried the request).
//   - If a row exists but belongs to someone else: 404.
export async function createDraft(
  sb: SupabaseClient,
  input: CreateDraftInput,
): Promise<{ status: "created" | "existing" | "not_mine"; row: DraftRow | null }> {
  const existing = await sb
    .from("invoice_drafts")
    .select(DRAFT_COLS)
    .eq("id", input.id)
    .maybeSingle();
  if (existing.data) {
    const row = existing.data as unknown as DraftRow;
    if (row.owner_email !== input.ownerEmail) return { status: "not_mine", row: null };
    return { status: "existing", row };
  }
  const insert = await sb
    .from("invoice_drafts")
    .insert({
      id: input.id,
      owner_email: input.ownerEmail,
      owner_worker_id: input.ownerWorkerId,
      account_key: input.accountKey,
      type: "invoice",
      gl_breakdown: [],
      answers: {},
      screen: input.screen,
      status: "draft",
    })
    .select(DRAFT_COLS)
    .maybeSingle();
  if (insert.error || !insert.data) {
    // The id may have landed concurrently; retry the read as the
    // existing-row path above.
    const retry = await sb
      .from("invoice_drafts")
      .select(DRAFT_COLS)
      .eq("id", input.id)
      .maybeSingle();
    if (retry.data) {
      const row = retry.data as unknown as DraftRow;
      if (row.owner_email !== input.ownerEmail) return { status: "not_mine", row: null };
      return { status: "existing", row };
    }
    return { status: "created", row: null };
  }
  return { status: "created", row: insert.data as unknown as DraftRow };
}

// Columns the client is allowed to patch. `status` + `submission_id`
// + `discarded_at` + `created_at` + ids never arrive here.
export interface DraftPatch {
  vendor_id?: string | null;
  type?: InvoiceKind;
  invoice_number?: string | null;
  invoice_date?: string | null;
  total_amount?: number | null;
  gl_breakdown?: GlLineDraft[];
  answers?: DraftAnswers;
  screen?: DraftScreen | null;
}

export type PatchDraftResult =
  | { status: "ok"; row: DraftRow }
  | { status: "conflict" }          // If-Match mismatch (another tab saved)
  | { status: "not_found" }
  | { status: "frozen" }            // the draft is not 'draft' any more
  | { status: "error"; detail: string }; // DB error: FK violation, type, timeout, etc.

// If-Match: the client sends the `updated_at` it has. The server
// filters on `.eq("updated_at", ifMatch)` and returns the updated
// row (which carries a fresh `updated_at`). No matching row -> 409.
// Clients queue their own next save to carry the fresh timestamp
// (correction 8). Train 2b correction 4.2 distinguishes a true
// conflict (no row matched the If-Match) from a DB error (FK
// violation on bad vendor_id, type error, etc.) - the client needs
// different handling for each: conflict reloads, error retries with
// backoff.
export async function patchDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
  ifMatch: string,
  patch: DraftPatch,
): Promise<PatchDraftResult> {
  // First: is the draft even there and mine? A missing row and a
  // "not mine" row are both 404.
  const existing = await getDraftById(sb, ownerEmail, draftId);
  if (!existing) return { status: "not_found" };
  if (existing.status !== "draft") return { status: "frozen" };

  // Build the update body from only the keys the client sent. A
  // missing key is "do not change this column".
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("vendor_id"      in patch) body.vendor_id      = patch.vendor_id;
  if ("type"           in patch) body.type           = patch.type;
  if ("invoice_number" in patch) body.invoice_number = patch.invoice_number;
  if ("invoice_date"   in patch) body.invoice_date   = patch.invoice_date;
  if ("total_amount"   in patch) body.total_amount   = patch.total_amount;
  if ("gl_breakdown"   in patch) body.gl_breakdown   = patch.gl_breakdown;
  if ("answers"        in patch) body.answers        = patch.answers;
  if ("screen"         in patch) body.screen         = patch.screen;

  const q = await sb
    .from("invoice_drafts")
    .update(body)
    .eq("id", draftId)
    .eq("owner_email", ownerEmail)
    .eq("updated_at", ifMatch)
    .eq("status", "draft")
    .select(DRAFT_COLS)
    .maybeSingle();
  if (q.error) {
    // A PostgREST / database error - never a concurrent-edit conflict.
    // Returns a short code string so the client can show a plain
    // sentence; no SQL or table names leaked.
    const code = typeof (q.error as { code?: unknown }).code === "string"
      ? (q.error as { code: string }).code
      : "error";
    return { status: "error", detail: code };
  }
  if (!q.data) return { status: "conflict" };
  return { status: "ok", row: q.data as unknown as DraftRow };
}

export async function discardDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<DraftRow | null> {
  const q = await sb
    .from("invoice_drafts")
    .update({
      status: "discarded",
      discarded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .eq("owner_email", ownerEmail)
    .eq("status", "draft")
    .select(DRAFT_COLS)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as DraftRow;
}

export async function undoDiscardDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<DraftRow | null> {
  const q = await sb
    .from("invoice_drafts")
    .update({
      status: "draft",
      discarded_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .eq("owner_email", ownerEmail)
    .eq("status", "discarded")
    .select(DRAFT_COLS)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as DraftRow;
}

// ─── Files ────────────────────────────────────────────────────────

const FILE_COLS =
  "id, draft_id, submission_id, kind, storage_path, file_name, mime_type, " +
  "size_bytes, sha256, page_count, sort_order, rotation, uploaded_by, " +
  "created_at, removed_at";

export interface InsertFileInput {
  id: string;                      // caller-generated
  draftId: string;
  storagePath: string;             // built on the server
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  sortOrder: number;
  uploadedBy: string;              // lower-cased
}

// Insert the file row. `storage_path` is UNIQUE so a repeat insert
// of the same path returns the existing row if it is already there.
export async function insertFile(
  sb: SupabaseClient,
  input: InsertFileInput,
): Promise<{ status: "created" | "existing" | "err"; row: import("./types").FileRow | null; err?: string }> {
  // First check for an existing row at this storage_path.
  const existing = await sb
    .from("invoice_files")
    .select(FILE_COLS)
    .eq("storage_path", input.storagePath)
    .maybeSingle();
  if (existing.data) {
    return { status: "existing", row: existing.data as unknown as import("./types").FileRow };
  }
  const ins = await sb
    .from("invoice_files")
    .insert({
      id: input.id,
      draft_id: input.draftId,
      kind: "original",
      storage_path: input.storagePath,
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      sha256: input.sha256,
      page_count: input.pageCount,
      sort_order: input.sortOrder,
      rotation: 0,
      uploaded_by: input.uploadedBy,
    })
    .select(FILE_COLS)
    .maybeSingle();
  if (ins.error || !ins.data) {
    // Concurrent insert?
    const retry = await sb
      .from("invoice_files")
      .select(FILE_COLS)
      .eq("storage_path", input.storagePath)
      .maybeSingle();
    if (retry.data) return { status: "existing", row: retry.data as unknown as import("./types").FileRow };
    return { status: "err", row: null, err: ins.error?.message ?? "insert_failed" };
  }
  return { status: "created", row: ins.data as unknown as import("./types").FileRow };
}

export async function patchFile(
  sb: SupabaseClient,
  draftId: string,
  fileId: string,
  body: { rotation?: 0 | 90 | 180 | 270; sort_order?: number },
): Promise<import("./types").FileRow | null> {
  const update: Record<string, unknown> = {};
  if (typeof body.rotation === "number") update.rotation = body.rotation;
  if (typeof body.sort_order === "number") update.sort_order = body.sort_order;
  if (Object.keys(update).length === 0) return null;
  const q = await sb
    .from("invoice_files")
    .update(update)
    .eq("id", fileId)
    .eq("draft_id", draftId)
    .is("removed_at", null)
    .select(FILE_COLS)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as import("./types").FileRow;
}

export async function removeFile(
  sb: SupabaseClient,
  draftId: string,
  fileId: string,
): Promise<boolean> {
  const q = await sb
    .from("invoice_files")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", fileId)
    .eq("draft_id", draftId)
    .is("removed_at", null);
  if (q.error) return false;
  return true;
}

// Train 2b correction 4.7: undo for a removed file. Clears
// removed_at only when the file is currently removed. No DELETE.
export async function unremoveFile(
  sb: SupabaseClient,
  draftId: string,
  fileId: string,
): Promise<import("./types").FileRow | null> {
  const q = await sb
    .from("invoice_files")
    .update({ removed_at: null })
    .eq("id", fileId)
    .eq("draft_id", draftId)
    .not("removed_at", "is", null)
    .select(FILE_COLS)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as import("./types").FileRow;
}
