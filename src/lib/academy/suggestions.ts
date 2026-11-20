// src/lib/academy/suggestions.ts
//
// Reader "Suggest an edit" write path + owner "Suggestions" read
// paths + owner action state machine (L4b).
//
// Nothing here reads cookies or headers directly; the route handler
// does the session + gate work and hands this file the signed-in
// email. A caller that does not pass an email cannot submit - the
// function never reaches for the request, so a broken caller refuses
// rather than inserts under a wrong name.
//
// Every value stored in `document_issues.issue_text` /
// `document_issues.suggested_text` / `document_issues.handled_note`
// is plain text. Nothing in this file renders those fields as HTML;
// the owner's list and the sender's list use React text nodes.
//
// Caps:
//   issue_text     1 .. 4000 characters (trimmed)
//   suggested_text 0 .. 8000 characters (trimmed; 0 means "not given")
//   handled_note   0 .. 2000 characters (decline reason; trimmed)
//
// Rate limit (reader write path):
//   Burst: 5 OPEN per reporter per rolling 60 s.
//   Daily: 30 regardless of status per reporter per rolling 24 h.
// Fail closed - a count-query error refuses the submission.
//
// State machine (L4b). Four states on the owner's screen; stored
// using only the columns the table already has:
//
//     screen label                 status        handled_outcome
//     ----------------             -----------   ---------------
//     Open                         open          null
//     Accepted - not changed yet   in_progress   used
//     Done                         closed        used
//     Declined                     closed        no_change
//
// `used` and `no_change` are the only values the chk_issue_outcome
// constraint allows, so we stay inside the stored shape and only
// change the words on the screen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import { resolveReaderLevel, canReadDocument } from "./access";
import { lookupSection } from "./outline";

export const ISSUE_TEXT_MAX = 4000;
export const SUGGESTED_TEXT_MAX = 8000;
export const HANDLED_NOTE_MAX = 2000;
export const RATE_LIMIT_BURST_WINDOW_MS = 60_000;
export const RATE_LIMIT_BURST_MAX = 5;
export const RATE_LIMIT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_DAILY_MAX = 30;

export type SubmitArgs = {
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
  | { ok: true; id: string; row: SuggestionRow };

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
  handled_outcome: string | null;
  handled_by: string | null;
  handled_at: string | null;
  handled_note: string | null;
  created_at: string | null;
};

// The "screen state" a row sits in. Derived from (status,
// handled_outcome). "unknown" catches any row shape the table might
// grow in a future train; the owner's page renders it in Closed as
// a safe fallback so no row ever just disappears.
export type ScreenState = "open" | "accepted" | "done" | "declined" | "unknown";

export function screenStateFor(
  status: string | null,
  outcome: string | null,
): ScreenState {
  const s = (status || "").toLowerCase();
  const o = (outcome || "").toLowerCase();
  if (s === "open") return "open";
  if (s === "in_progress" && o === "used") return "accepted";
  if (s === "closed" && o === "used") return "done";
  if (s === "closed" && o === "no_change") return "declined";
  return "unknown";
}

function normEmail(e: string | null | undefined): string {
  return String(e || "").trim().toLowerCase();
}

// -----------------------------------------------------------------
// Reader write path - unchanged from L3+L4 except the column list
// now carries the new L4b columns on the returned row shape.
// -----------------------------------------------------------------
export async function submitSuggestionForEmail(
  args: SubmitArgs,
  supaIn?: SupabaseClient,
): Promise<SubmitResult> {
  const email = normEmail(args.email);
  if (!email) return { ok: false, error: "unauthenticated" };

  const supa = supaIn || serviceClient();

  const issueText = String(args.issueText || "").trim();
  if (issueText.length === 0) return { ok: false, error: "text_empty" };
  if (issueText.length > ISSUE_TEXT_MAX) return { ok: false, error: "text_too_long" };
  const suggestedRaw = args.suggestedText == null ? "" : String(args.suggestedText).trim();
  if (suggestedRaw.length > SUGGESTED_TEXT_MAX) {
    return { ok: false, error: "suggested_too_long" };
  }
  const suggestedText = suggestedRaw.length === 0 ? null : suggestedRaw;

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
    return { ok: false, error: "doc_not_readable" };
  }

  const sec = await lookupSection(args.docId, args.sectionKey, supa);
  if (!sec.ok) {
    if (sec.reason === "section_missing") {
      return { ok: false, error: "section_not_in_doc" };
    }
    return { ok: false, error: "doc_not_found" };
  }

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
    .select(ROW_SELECT)
    .single();
  if (insQ.error) {
    return { ok: false, error: "server_error", detail: insQ.error.message };
  }
  const inserted = insQ.data as SuggestionRow;
  return { ok: true, id: inserted.id, row: inserted };
}

// -----------------------------------------------------------------
// Owner lists. Three queries on the same shape.
// -----------------------------------------------------------------

const ROW_SELECT =
  "id, doc_id, reporter_email, section_key, section_title, doc_version, issue_text, suggested_text, status, handled_outcome, handled_by, handled_at, handled_note, created_at";

export type OwnerListRow = SuggestionRow & { doc_title: string | null };

export type ListResult =
  | { ok: false; error: string }
  | { ok: true; rows: OwnerListRow[] };

async function listByStates(
  pairs: Array<{ status: string; outcome?: string | null }>,
  supaIn?: SupabaseClient,
): Promise<ListResult> {
  const supa = supaIn || serviceClient();
  // One query per (status, outcome) pair so a nullable outcome can
  // be matched with .is(). PostgREST does not combine neq/eq with
  // or() against nullable outcome cleanly; two round trips at most
  // (we call this with 1 or 2 pairs) is cheaper than a view.
  const results: SuggestionRow[] = [];
  for (const p of pairs) {
    let q = supa
      .from("document_issues")
      .select(ROW_SELECT)
      .eq("status", p.status);
    if (p.outcome === null) {
      q = q.is("handled_outcome", null);
    } else if (typeof p.outcome === "string") {
      q = q.eq("handled_outcome", p.outcome);
    }
    const rr = await q.order("created_at", { ascending: false }).limit(1000);
    if (rr.error) return { ok: false, error: rr.error.message };
    for (const r of (rr.data as SuggestionRow[]) || []) results.push(r);
  }
  results.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const uniq = Array.from(new Set(results.map((r) => r.doc_id)));
  const titleMap = new Map<string, string | null>();
  if (uniq.length > 0) {
    const docQ = await supa.from("documents").select("id, title").in("id", uniq);
    if (!docQ.error) {
      for (const d of (docQ.data as Array<{ id: string; title: string | null }>) || []) {
        titleMap.set(d.id, d.title);
      }
    }
  }
  return {
    ok: true,
    rows: results.map((r) => ({ ...r, doc_title: titleMap.get(r.doc_id) ?? null })),
  };
}

export function listOpenSuggestions(supaIn?: SupabaseClient): Promise<ListResult> {
  return listByStates([{ status: "open", outcome: null }], supaIn);
}
export function listAcceptedSuggestions(supaIn?: SupabaseClient): Promise<ListResult> {
  return listByStates([{ status: "in_progress", outcome: "used" }], supaIn);
}
export function listClosedSuggestions(supaIn?: SupabaseClient): Promise<ListResult> {
  return listByStates(
    [
      { status: "closed", outcome: "used" },
      { status: "closed", outcome: "no_change" },
    ],
    supaIn,
  );
}

// Count only - the bookcase "Suggestions N waiting" snippet reads
// this. We count OPEN + ACCEPTED-NOT-CHANGED together, so the badge
// is honest about what still needs the owner's attention.
export async function countActiveSuggestions(
  supaIn?: SupabaseClient,
): Promise<number> {
  const supa = supaIn || serviceClient();
  const [openQ, acceptedQ] = await Promise.all([
    supa
      .from("document_issues")
      .select("id", { count: "exact", head: true })
      .eq("status", "open"),
    supa
      .from("document_issues")
      .select("id", { count: "exact", head: true })
      .eq("status", "in_progress")
      .eq("handled_outcome", "used"),
  ]);
  if (openQ.error || acceptedQ.error) return 0;
  return (openQ.count ?? 0) + (acceptedQ.count ?? 0);
}

// Kept for backwards source compatibility; `countActiveSuggestions`
// is the one the Library page should call now.
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

// -----------------------------------------------------------------
// Owner action state machine (L4b).
// -----------------------------------------------------------------
export type OwnerAction = "accept" | "mark_done" | "decline" | "reopen";

export type ActionError =
  | "not_found"
  | "wrong_state"
  | "reason_too_long"
  | "server_error";

export type ActionResult = { ok: true } | { ok: false; error: ActionError };

// Which screen states each action is allowed FROM.
const ACTION_ALLOWED_FROM: Record<OwnerAction, ScreenState[]> = {
  accept: ["open"],
  mark_done: ["accepted"],
  decline: ["open", "accepted"],
  reopen: ["accepted", "done", "declined"],
};

export async function applyOwnerAction(
  id: string,
  action: OwnerAction,
  ownerEmail: string,
  options: { reason?: string | null } = {},
  supaIn?: SupabaseClient,
): Promise<ActionResult> {
  const supa = supaIn || serviceClient();

  const rowQ = await supa
    .from("document_issues")
    .select("id, status, handled_outcome")
    .eq("id", id)
    .maybeSingle();
  if (rowQ.error) return { ok: false, error: "server_error" };
  if (!rowQ.data) return { ok: false, error: "not_found" };
  const row = rowQ.data as {
    id: string;
    status: string | null;
    handled_outcome: string | null;
  };
  const state = screenStateFor(row.status, row.handled_outcome);
  if (!ACTION_ALLOWED_FROM[action].includes(state)) {
    return { ok: false, error: "wrong_state" };
  }

  // Build the update patch. We never trust the request for
  // handled_by; the owner's session email is the only input.
  const now = new Date().toISOString();
  const by = normEmail(ownerEmail);
  // Narrow, server-authored patch object.
  const patch: Record<string, string | null> = {};
  switch (action) {
    case "accept":
      patch.status = "in_progress";
      patch.handled_outcome = "used";
      patch.handled_by = by;
      patch.handled_at = now;
      patch.handled_note = null;
      break;
    case "mark_done":
      patch.status = "closed";
      patch.handled_outcome = "used";
      // Keep the acceptor's name + timestamp; this is the same
      // owner closing it, but even if two owners split the step a
      // later audit tells who did Done from `handled_at`.
      patch.handled_by = by;
      patch.handled_at = now;
      break;
    case "decline": {
      const reasonRaw = (options.reason ?? "").toString().trim();
      if (reasonRaw.length > HANDLED_NOTE_MAX) {
        return { ok: false, error: "reason_too_long" };
      }
      patch.status = "closed";
      patch.handled_outcome = "no_change";
      patch.handled_by = by;
      patch.handled_at = now;
      patch.handled_note = reasonRaw.length === 0 ? null : reasonRaw;
      break;
    }
    case "reopen":
      patch.status = "open";
      patch.handled_outcome = null;
      patch.handled_by = null;
      patch.handled_at = null;
      patch.handled_note = null;
      break;
  }

  const updQ = await supa
    .from("document_issues")
    .update(patch)
    .eq("id", id)
    .eq("status", row.status)
    .select("id")
    .maybeSingle();
  if (updQ.error) return { ok: false, error: "server_error" };
  if (!updQ.data) {
    // Someone moved the row between our read and our write.
    return { ok: false, error: "wrong_state" };
  }
  return { ok: true };
}

// -----------------------------------------------------------------
// Sender's own list - "Your suggestions" at /library/suggestions/mine.
// The server resolves the viewer's email from the signed-in session;
// this function only accepts that email and never widens its query.
//
// `may_read` is computed server-side with the viewer's reader level
// and the document's access_level. For rows on a document the
// viewer may not read today, we scrub the doc_title and the
// section_title; the number remains because the sender already
// knows it (they typed the number into the reader when they sent
// the note). The row's own fields - the viewer's own text - stay
// so the sender can see their note and state. The sender's email
// is never written back into the payload so nothing on this page
// carries it in the markup.
// -----------------------------------------------------------------
export type MineRow = {
  id: string;
  doc_id: string;
  doc_title: string | null;
  section_key: string | null;
  section_title: string | null;
  doc_version: string | null;
  issue_text: string;
  suggested_text: string | null;
  screen_state: ScreenState;
  handled_outcome: string | null;
  handled_note: string | null;
  may_read: boolean;
  created_at: string | null;
};

export type MineResult =
  | { ok: false; error: string }
  | { ok: true; rows: MineRow[] };

export async function listMineForEmail(
  email: string,
  supaIn?: SupabaseClient,
): Promise<MineResult> {
  const supa = supaIn || serviceClient();
  const normalized = normEmail(email);
  if (!normalized) return { ok: true, rows: [] };

  const q = await supa
    .from("document_issues")
    .select(
      "id, doc_id, section_key, section_title, doc_version, issue_text, suggested_text, status, handled_outcome, handled_note, created_at",
    )
    .eq("reporter_email", normalized)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (q.error) return { ok: false, error: q.error.message };
  type R = {
    id: string;
    doc_id: string;
    section_key: string | null;
    section_title: string | null;
    doc_version: string | null;
    issue_text: string;
    suggested_text: string | null;
    status: string | null;
    handled_outcome: string | null;
    handled_note: string | null;
    created_at: string | null;
  };
  const rows = (q.data as R[]) || [];
  if (rows.length === 0) return { ok: true, rows: [] };

  // May-read check: resolve identity + reader level once, then look
  // up the distinct doc ids with their access_level so we can scrub
  // titles for docs the viewer cannot read today.
  let identity: Awaited<ReturnType<typeof resolveAcademyIdentity>> = null;
  try {
    identity = await resolveAcademyIdentity(normalized, { supa });
  } catch {
    identity = null;
  }
  const level = resolveReaderLevel(normalized, identity);

  const uniq = Array.from(new Set(rows.map((r) => r.doc_id)));
  const docQ = await supa
    .from("documents")
    .select("id, title, status, access_level")
    .in("id", uniq);
  type D = {
    id: string;
    title: string | null;
    status: string;
    access_level: string | null;
  };
  const docs = new Map<string, D>();
  if (!docQ.error) {
    for (const d of (docQ.data as D[]) || []) docs.set(d.id, d);
  }

  const out: MineRow[] = rows.map((r) => {
    const d = docs.get(r.doc_id);
    const liveAndReadable =
      !!d && d.status === "Live" && canReadDocument(level, d.access_level);
    return {
      id: r.id,
      doc_id: r.doc_id,
      doc_title: liveAndReadable ? d?.title ?? null : null,
      section_key: liveAndReadable ? r.section_key : null,
      section_title: liveAndReadable ? r.section_title : null,
      doc_version: r.doc_version,
      issue_text: r.issue_text,
      suggested_text: r.suggested_text,
      screen_state: screenStateFor(r.status, r.handled_outcome),
      handled_outcome: r.handled_outcome,
      handled_note: r.handled_note,
      may_read: liveAndReadable,
      created_at: r.created_at,
    };
  });
  return { ok: true, rows: out };
}

// Does this viewer have at least one note of their own? Used by the
// end-of-document close to decide whether to show the quiet "Your
// suggestions" link. `head: true` + count to keep it cheap.
export async function hasOwnSuggestions(
  email: string,
  supaIn?: SupabaseClient,
): Promise<boolean> {
  const normalized = normEmail(email);
  if (!normalized) return false;
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("document_issues")
    .select("id", { count: "exact", head: true })
    .eq("reporter_email", normalized);
  if (q.error) return false;
  return (q.count ?? 0) > 0;
}
