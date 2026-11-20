// src/lib/academy/suggestions.ts
//
// Reader "Suggest an edit" write path and owner "Suggestions" read
// path. Nothing here reads cookies or headers directly; the route
// handler (src/app/api/academy/library/suggestions/route.ts) does
// the session + gate work and hands this file the signed-in email.
// A caller that does not pass an email cannot submit - the function
// never reaches for the request, so a broken caller refuses rather
// than inserts under a wrong name.
//
// Every value stored in `document_issues.issue_text` /
// `document_issues.suggested_text` is plain text. We never render
// either field as HTML; the owner's list renders them inside React
// text nodes, which escapes them automatically. The write path
// trims whitespace but does NOT strip tags - keeping the text a
// user typed is the honest thing; rendering decides the safety.
//
// Caps (choice, documented in the ledger line + ACADEMY.md):
//   issue_text     1 .. 4000 characters (trimmed)
//   suggested_text 0 .. 8000 characters (trimmed; 0 means "not given")
//
// Rate limit (choice, documented too):
//   Burst cap:   5 OPEN suggestions per reporter_email per rolling
//                60 seconds.
//   Daily cap:  30 suggestions per reporter_email per rolling 24
//                hours, counted regardless of status (so an owner
//                closing notes does not refill the quota).
// Both caps are enforced without a new table: two count queries
// scoped to the reporter's email and a time window. **Fail closed:**
// if either count query returns an error, the submission is refused.
// We would rather occasionally refuse a genuine reader than silently
// let a flood through because the DB blipped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import { resolveReaderLevel, canReadDocument } from "./access";
import { lookupSection } from "./outline";

export const ISSUE_TEXT_MAX = 4000;
export const SUGGESTED_TEXT_MAX = 8000;
export const RATE_LIMIT_BURST_WINDOW_MS = 60_000;
export const RATE_LIMIT_BURST_MAX = 5;
export const RATE_LIMIT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_DAILY_MAX = 30;

export type SubmitArgs = {
  // Server-sourced session email. Callers (the route handler) read
  // this from the signed-in session; this function never reads from
  // the request body for the reporter_email.
  email: string;
  docId: string;
  issueText: string;
  sectionKey: string | null;
  suggestedText?: string | null;
};

export type SubmitError =
  | "unauthenticated"
  | "doc_not_found"
  | "doc_not_readable"
  | "section_not_in_doc"
  | "text_empty"
  | "text_too_long"
  | "suggested_too_long"
  | "rate_limited"
  | "server_error";

export type SubmitResult =
  | { ok: false; error: SubmitError; detail?: string }
  | {
      ok: true;
      id: string;
      row: SuggestionRow;
    };

export type SuggestionRow = {
  id: string;
  doc_id: string;
  reporter_email: string | null;
  section_key: string | null;
  section_title: string | null;
  doc_version: string | null;
  issue_text: string;
  suggested_text: string | null;
  status: string;
  created_at: string | null;
};

function normEmail(e: string | null | undefined): string {
  return String(e || "").trim().toLowerCase();
}

// -----------------------------------------------------------------
// Submit - the write path. Runs every gate in order and inserts on
// success. On any refusal, no row is written.
// -----------------------------------------------------------------
export async function submitSuggestionForEmail(
  args: SubmitArgs,
  supaIn?: SupabaseClient,
): Promise<SubmitResult> {
  const email = normEmail(args.email);
  if (!email) return { ok: false, error: "unauthenticated" };

  const supa = supaIn || serviceClient();

  // Text validation (trim then cap). We refuse an empty issue_text
  // so a stray double-send does not create a blank note.
  const issueText = String(args.issueText || "").trim();
  if (issueText.length === 0) return { ok: false, error: "text_empty" };
  if (issueText.length > ISSUE_TEXT_MAX) return { ok: false, error: "text_too_long" };
  const suggestedRaw = args.suggestedText == null ? "" : String(args.suggestedText).trim();
  if (suggestedRaw.length > SUGGESTED_TEXT_MAX) {
    return { ok: false, error: "suggested_too_long" };
  }
  const suggestedText = suggestedRaw.length === 0 ? null : suggestedRaw;

  // Doc existence + may-read gate. Mirror of document.ts stage-1:
  // read {id, status, access_level}, enforce Live, then resolve the
  // reader's level and refuse if restricted.
  const docGateQ = await supa
    .from("documents")
    .select("id, status, access_level")
    .eq("id", args.docId)
    .maybeSingle();
  if (docGateQ.error) {
    return { ok: false, error: "server_error", detail: "doc lookup" };
  }
  if (!docGateQ.data) return { ok: false, error: "doc_not_found" };
  const gateRow = docGateQ.data as {
    id: string;
    status: string;
    access_level: string | null;
  };
  if (gateRow.status !== "Live") return { ok: false, error: "doc_not_found" };
  let identity: Awaited<ReturnType<typeof resolveAcademyIdentity>> = null;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch {
    identity = null;
  }
  const level = resolveReaderLevel(email, identity);
  if (!canReadDocument(level, gateRow.access_level)) {
    // Identical shape to "doc_not_found" so the handler can reply
    // the same way for both; the caller is not told which.
    return { ok: false, error: "doc_not_readable" };
  }

  // Section lookup - server decides the title; client cannot rename.
  const sec = await lookupSection(args.docId, args.sectionKey, supa);
  if (!sec.ok) {
    if (sec.reason === "section_missing") {
      return { ok: false, error: "section_not_in_doc" };
    }
    return { ok: false, error: "doc_not_found" };
  }

  // Rate limit - two caps, fail closed. An error on either query
  // refuses the submission.
  const nowMs = Date.now();
  const burstSinceIso = new Date(nowMs - RATE_LIMIT_BURST_WINDOW_MS).toISOString();
  const dailySinceIso = new Date(nowMs - RATE_LIMIT_DAILY_WINDOW_MS).toISOString();
  const [burstQ, dailyQ] = await Promise.all([
    supa
      .from("document_issues")
      .select("id", { count: "exact", head: true })
      .eq("reporter_email", email)
      .eq("status", "open")
      .gte("created_at", burstSinceIso),
    supa
      .from("document_issues")
      .select("id", { count: "exact", head: true })
      .eq("reporter_email", email)
      .gte("created_at", dailySinceIso),
  ]);
  if (burstQ.error || dailyQ.error) {
    return { ok: false, error: "rate_limited", detail: "count_query_failed" };
  }
  if ((burstQ.count ?? 0) >= RATE_LIMIT_BURST_MAX) {
    return { ok: false, error: "rate_limited", detail: "burst" };
  }
  if ((dailyQ.count ?? 0) >= RATE_LIMIT_DAILY_MAX) {
    return { ok: false, error: "rate_limited", detail: "daily" };
  }

  // Insert. data_provenance="manual_entry" and status default to
  // "open" per the table definition; we set them explicitly so the
  // probe reads the same shape whichever default lands.
  const row = {
    doc_id: args.docId,
    reporter_email: email,
    section_key: args.sectionKey && args.sectionKey.length > 0 ? args.sectionKey : null,
    section_title: sec.title,
    doc_version: sec.version,
    issue_text: issueText,
    suggested_text: suggestedText,
    status: "open",
    data_provenance: "manual_entry",
  };
  const insQ = await supa
    .from("document_issues")
    .insert(row)
    .select(
      "id, doc_id, reporter_email, section_key, section_title, doc_version, issue_text, suggested_text, status, created_at",
    )
    .single();
  if (insQ.error) {
    return { ok: false, error: "server_error", detail: insQ.error.message };
  }
  const inserted = insQ.data as SuggestionRow;
  return { ok: true, id: inserted.id, row: inserted };
}

// -----------------------------------------------------------------
// Owner list - open suggestions, newest first. Optional 'closed'
// mode so the probe can read what it just wrote and put back.
// -----------------------------------------------------------------
export type ListResult =
  | { ok: false; error: string }
  | { ok: true; rows: Array<SuggestionRow & { doc_title: string | null }> };

export async function listOpenSuggestions(
  supaIn?: SupabaseClient,
): Promise<ListResult> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("document_issues")
    .select(
      "id, doc_id, reporter_email, section_key, section_title, doc_version, issue_text, suggested_text, status, created_at",
    )
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (q.error) return { ok: false, error: q.error.message };
  const rows = (q.data as SuggestionRow[]) || [];
  if (rows.length === 0) return { ok: true, rows: [] };
  const uniq = Array.from(new Set(rows.map((r) => r.doc_id)));
  const docQ = await supa
    .from("documents")
    .select("id, title")
    .in("id", uniq);
  const titleMap = new Map<string, string | null>();
  if (!docQ.error) {
    for (const d of (docQ.data as Array<{ id: string; title: string | null }>) || []) {
      titleMap.set(d.id, d.title);
    }
  }
  return {
    ok: true,
    rows: rows.map((r) => ({ ...r, doc_title: titleMap.get(r.doc_id) ?? null })),
  };
}

// Count only - used by the Bookcase link ("Suggestions N") the owner
// sees. Returns 0 on any read error (the link stays hidden), so a
// transient DB blip does not stop the Library loading.
export async function countOpenSuggestions(
  supaIn?: SupabaseClient,
): Promise<number> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("document_issues")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  if (q.error) return 0;
  return q.count ?? 0;
}

// Owner "Used" / "No change" - sets handled_by + handled_at +
// handled_outcome and closes the row.
export type HandleOutcome = "used" | "no_change";
export async function handleSuggestion(
  id: string,
  outcome: HandleOutcome,
  handlerEmail: string,
  supaIn?: SupabaseClient,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("document_issues")
    .update({
      status: "closed",
      handled_by: normEmail(handlerEmail),
      handled_at: new Date().toISOString(),
      handled_outcome: outcome,
    })
    .eq("id", id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (q.error) return { ok: false, error: q.error.message };
  if (!q.data) return { ok: false, error: "not_found_or_already_closed" };
  return { ok: true };
}
