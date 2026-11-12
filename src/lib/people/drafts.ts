// T4a (2026-11-13). Draft CRUD for the PAF form.
//
// Table shape (confirmed against the live DB; migration is NOT in
// this repo's supabase/migrations/ yet - see state doc):
//   id              uuid
//   owner_email     text   (lower-cased)
//   module          text   ('paf' in this train)
//   action_type     text   (v1 code: 'add_bonus', 'add_deduction',
//                           'add_gratuity', ...)
//   person_name     text
//   payload         jsonb
//   unsent          boolean  (true until T4c sends it)
//   last_error      text
//   created_at      timestamptz
//   updated_at      timestamptz
//
// RULES
//
//   1. Every read and every write filters on `owner_email` server-
//      side. A `?draft=<id>` whose row is not the caller's returns
//      null from loadDraft() - the page turns that into notFound().
//
//   2. Owner preview never writes. Callers hold `viewer.previewOf`;
//      when non-null the API refuses the mutation. This file does
//      not consult viewer.previewOf directly - the API route does -
//      but the comments here mirror the rule.
//
//   3. Nothing in this file writes to `submissions` or sends email.
//      Autosave only touches people_drafts. T4c changes that.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PafDraft {
  id: string;
  owner_email: string;
  module: string;
  action_type: string | null;
  person_name: string | null;
  payload: Record<string, unknown>;
  unsent: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toDraft(row: Record<string, unknown>): PafDraft {
  const rawPayload = row.payload;
  let payload: Record<string, unknown>;
  if (rawPayload && typeof rawPayload === "object") {
    payload = rawPayload as Record<string, unknown>;
  } else if (typeof rawPayload === "string") {
    try { payload = JSON.parse(rawPayload) as Record<string, unknown>; }
    catch { payload = {}; }
  } else {
    payload = {};
  }
  return {
    id: String(row.id),
    owner_email: String(row.owner_email ?? ""),
    module: String(row.module ?? ""),
    action_type: (row.action_type as string | null) ?? null,
    person_name: (row.person_name as string | null) ?? null,
    payload,
    unsent: row.unsent !== false,
    last_error: (row.last_error as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

// Read one draft. The owner_email filter is the enforcement point:
// a draft belonging to anyone else returns null. The page turns a
// null here into notFound() so no 403 body leaks.
export async function loadDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  id: string,
): Promise<PafDraft | null> {
  const q = await sb
    .from("people_drafts")
    .select("*")
    .eq("owner_email", ownerEmail)
    .eq("id", id)
    .maybeSingle();
  if (q.error || !q.data) return null;
  return toDraft(q.data as Record<string, unknown>);
}

// Read all of a viewer's drafts (used by the Inbox to show them in
// Needs you). owner_email filter is the enforcement point here too.
export async function listDrafts(
  sb: SupabaseClient,
  ownerEmail: string,
): Promise<PafDraft[]> {
  const q = await sb
    .from("people_drafts")
    .select("*")
    .eq("owner_email", ownerEmail)
    .order("updated_at", { ascending: false });
  if (q.error) return [];
  return (q.data ?? []).map((row) => toDraft(row as Record<string, unknown>));
}

// Create a draft. Does the first autosave implicitly. Returns the
// new draft so the client can switch its URL to `?draft=<id>`.
export async function createDraft(
  sb: SupabaseClient,
  input: {
    owner_email: string;
    module: string;
    action_type: string | null;
    person_name: string | null;
    payload: Record<string, unknown>;
  },
): Promise<PafDraft | null> {
  const q = await sb
    .from("people_drafts")
    .insert({
      owner_email: input.owner_email,
      module: input.module,
      action_type: input.action_type,
      person_name: input.person_name,
      payload: input.payload,
      unsent: true,
    })
    .select("*")
    .maybeSingle();
  if (q.error || !q.data) return null;
  return toDraft(q.data as Record<string, unknown>);
}

// Update an existing draft. Owner filter means an id typed from
// another viewer's URL is a no-op (match returns 0 rows); the API
// route treats that as a 404.
export async function updateDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  id: string,
  patch: {
    action_type?: string | null;
    person_name?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<PafDraft | null> {
  const row: Record<string, unknown> = {};
  if (patch.action_type !== undefined) row.action_type = patch.action_type;
  if (patch.person_name !== undefined) row.person_name = patch.person_name;
  if (patch.payload !== undefined) row.payload = patch.payload;
  row.updated_at = new Date().toISOString();
  const q = await sb
    .from("people_drafts")
    .update(row)
    .eq("owner_email", ownerEmail)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (q.error || !q.data) return null;
  return toDraft(q.data as Record<string, unknown>);
}

// Delete. Same owner filter. Returns true on success; false means
// either an error or the id did not belong to this owner.
export async function deleteDraft(
  sb: SupabaseClient,
  ownerEmail: string,
  id: string,
): Promise<boolean> {
  const q = await sb
    .from("people_drafts")
    .delete()
    .eq("owner_email", ownerEmail)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (q.error) return false;
  return !!q.data;
}
