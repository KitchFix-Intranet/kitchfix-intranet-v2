// Server reads for `invoice_drafts` and `invoice_files`. Every read
// is filtered by `owner_email` so one viewer can never see another's
// drafts (§4). The route layer also checks `account_key` against the
// viewer's scope.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftRow, FileRow, DraftView, FileView } from "./types";

const DRAFT_COLS =
  "id, account_key, owner_email, vendor_id, type, invoice_number, invoice_date, " +
  "total_amount, gl_breakdown, answers, screen, status, submission_id, " +
  "created_at, updated_at, discarded_at";

const FILE_COLS =
  "id, draft_id, submission_id, kind, storage_path, file_name, mime_type, " +
  "size_bytes, sha256, page_count, sort_order, rotation, uploaded_by, " +
  "created_at, removed_at";

export async function getDraftById(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<DraftRow | null> {
  const q = await sb
    .from("invoice_drafts")
    .select(DRAFT_COLS)
    .eq("id", draftId)
    .eq("owner_email", ownerEmail)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as DraftRow;
}

// Live drafts (not discarded) for this viewer, scoped to a site.
// Newest first (updated_at). Owner_email + account_key both
// filtered on the server. Use this for the landing's B6 pane.
export async function listDraftsForOwnerSite(
  sb: SupabaseClient,
  ownerEmail: string,
  accountKey: string,
): Promise<DraftRow[]> {
  const q = await sb
    .from("invoice_drafts")
    .select(DRAFT_COLS)
    .eq("owner_email", ownerEmail)
    .eq("account_key", accountKey)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(500);
  if (q.error) return [];
  return (q.data as unknown as DraftRow[]) ?? [];
}

// Live drafts (not discarded) for this viewer, scoped to a site, in
// a stable fixed order: created_at ASC, then id as tie-break. The
// sitting's "N of M" pager (C1) and the "next draft" cursor use
// this ordering so cursors do not jump when a draft is re-saved.
export async function listDraftsForOwnerSiteFixedOrder(
  sb: SupabaseClient,
  ownerEmail: string,
  accountKey: string,
): Promise<DraftRow[]> {
  const q = await sb
    .from("invoice_drafts")
    .select(DRAFT_COLS)
    .eq("owner_email", ownerEmail)
    .eq("account_key", accountKey)
    .eq("status", "draft")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (q.error) return [];
  return (q.data as unknown as DraftRow[]) ?? [];
}

// Vendor names for a set of vendor_ids. Returns a Map from id to
// name. Reads only (id, name) - never selects portal_* or any
// contact field (train 1 §"vendor picker" discipline carries over).
export async function loadVendorNames(
  sb: SupabaseClient,
  vendorIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(vendorIds.filter(Boolean)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const q = await sb
    .from("vendors")
    .select("id, name")
    .in("id", unique);
  if (q.error) return out;
  for (const row of (q.data as Array<{ id: string; name: string }>) ?? []) {
    out.set(row.id, row.name);
  }
  return out;
}

// Every live draft for this viewer across every site. Used by the
// copy check to catch "another of this person's live drafts" per §6
// and by the dupe-sha check across drafts (§6 "same file twice").
export async function listLiveDraftsForOwner(
  sb: SupabaseClient,
  ownerEmail: string,
): Promise<DraftRow[]> {
  const q = await sb
    .from("invoice_drafts")
    .select(DRAFT_COLS)
    .eq("owner_email", ownerEmail)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(500);
  if (q.error) return [];
  return (q.data as unknown as DraftRow[]) ?? [];
}

export async function listFilesForDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  draftId: string,
): Promise<FileRow[]> {
  // Owner is enforced via the draft: we already load the draft by
  // (id, owner_email). The file table does not carry owner_email,
  // so we filter by draft_id and then rely on the caller having
  // owner-checked the draft.
  const q = await sb
    .from("invoice_files")
    .select(FILE_COLS)
    .eq("draft_id", draftId)
    .is("removed_at", null)
    .order("sort_order", { ascending: true });
  if (q.error) return [];
  return (q.data as unknown as FileRow[]) ?? [];
}

export async function getFileById(
  sb: SupabaseClient,
  fileId: string,
  draftId: string,
): Promise<FileRow | null> {
  // We always couple file id with draft id so a tampered file id
  // can never load a file from another draft.
  const q = await sb
    .from("invoice_files")
    .select(FILE_COLS)
    .eq("id", fileId)
    .eq("draft_id", draftId)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return q.data as unknown as FileRow;
}

// Live (not-removed) files across every live draft for this viewer.
// Used by the across-drafts same-SHA check on upload-finish.
export async function liveFilesForOwner(
  sb: SupabaseClient,
  ownerEmail: string,
): Promise<FileRow[]> {
  const drafts = await listLiveDraftsForOwner(sb, ownerEmail);
  const ids = drafts.map((d) => d.id);
  if (ids.length === 0) return [];
  const q = await sb
    .from("invoice_files")
    .select(FILE_COLS)
    .in("draft_id", ids)
    .is("removed_at", null);
  if (q.error) return [];
  return (q.data as unknown as FileRow[]) ?? [];
}

// ─── Client views (strip server-only fields) ──────────────────────

export function toDraftView(d: DraftRow): DraftView {
  return {
    id: d.id,
    account_key: d.account_key,
    vendor_id: d.vendor_id,
    type: d.type,
    invoice_number: d.invoice_number,
    invoice_date: d.invoice_date,
    total_amount: d.total_amount,
    gl_breakdown: d.gl_breakdown ?? [],
    answers: d.answers ?? {},
    screen: d.screen,
    status: d.status,
    submission_id: d.submission_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
    discarded_at: d.discarded_at,
  };
}

export function toFileView(f: FileRow): FileView {
  return {
    id: f.id,
    draft_id: f.draft_id ?? "",
    file_name: f.file_name,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes,
    page_count: f.page_count,
    sort_order: f.sort_order,
    rotation: f.rotation,
    created_at: f.created_at,
    removed_at: f.removed_at,
  };
}
