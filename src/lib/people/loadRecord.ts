// Record drawer loader for /people/inbox?rec=<submission_id>.
// Server-only. Does the "may open" check (R-PP21), parses the
// payload, builds the detail pairs + the "What happened" ledger,
// and returns a pre-rendered view object. The payload never leaves
// this file - every string the client sees is the output of a
// labelling helper.
//
// MAY-OPEN RULES (R-PP21):
//   true if viewer is the submitter
//   true if viewer has pp_full_access or pp_review
//   true if viewer sits in the PERSON's reports chain (not the
//        sender's) walked via people.manager_worker_id from the
//        person's manager upward
//   FALSE if the record is ABOUT the viewer but someone ELSE sent
//        it (self-by-other), even for pp_full_access / pp_review
//   when person_worker_id is null, only sender + pp_full_access +
//        pp_review may open (no chain to walk)
// Anyone else: notFound() in the page.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "./types";
import type { InboxKind } from "./inboxTypes";
import { labelForAction, routeFor } from "./labels";
import { fmtShort, fmtFull } from "./dates";
import { viewerIsInChain } from "./chain";
import { detailPairs } from "./recordDetail";

export interface RecordView {
  id: string;
  kind: InboxKind;
  eyebrow: string;         // "PAF · Travel reimbursement", "New Hire", "Incident Report"
  title: string;           // person name or "<club> · <dates>"
  status_display: string;
  status_code: "Pending" | "Complete" | "Rejected" | "Withdrawn" | "Cancelled";
  detail: Array<[string, string]>;
  // One sender's note. Empty when the sender left it blank.
  sender_note: string;
  // Rejection reason - only shown when status === "Rejected". Takes
  // submissions.notes (freetext, written by the admin on rejection).
  rejection_reason: string;
  // Ledger: a short list of "what happened" events. One line for
  // sent, one for the decision. When submission_events has rows for
  // this record we list those instead.
  ledger: Array<{ tone: "info" | "good" | "warn" | "muted"; what: string; means: string; when: string }>;
}

interface SubmissionRow {
  id: string;
  module: string | null;
  action_type: string | null;
  status: RecordView["status_code"] | null;
  submitted_at: string | null;
  admin_action_at: string | null;
  submitter_worker_id: string | null;
  person_worker_id: string | null;
  notes: string | null;
  payload: string | null;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function kindFromModule(m: string | null): InboxKind {
  const s = (m ?? "").toLowerCase();
  if (s === "paf") return "paf";
  if (s === "newhire") return "hire";
  if (s === "incident") return "incident";
  return "paf";
}

function statusDisplay(s: RecordView["status_code"] | null): string {
  if (s === "Complete") return "Approved";
  if (s === "Cancelled") return "Withdrawn";
  return s ?? "Pending";
}

// May-open check (R-PP21). See file header.
export async function mayOpen(
  sb: SupabaseClient,
  viewer: Viewer,
  row: SubmissionRow,
): Promise<boolean> {
  // Self-by-other: refuse even to pp_full_access / pp_review.
  if (row.person_worker_id === viewer.worker_id
    && row.submitter_worker_id !== viewer.worker_id) return false;
  // Sender always sees their own.
  if (row.submitter_worker_id === viewer.worker_id) return true;
  // pp_full_access or pp_review open everything else.
  if (viewer.pp_full_access || viewer.pp_review) return true;
  // Otherwise, chain walk the PERSON upward.
  if (!row.person_worker_id) return false;
  const q = await sb
    .from("people")
    .select("manager_worker_id")
    .eq("worker_id", row.person_worker_id)
    .maybeSingle();
  if (q.error || !q.data) return false;
  const rootManager = (q.data.manager_worker_id as string | null) ?? null;
  return viewerIsInChain(sb, viewer.worker_id, rootManager);
}

// Build the drawer view for a single record. The caller MUST have
// confirmed `mayOpen()` is true. Returns null when the id is not
// found at all; the caller should 404.
export async function loadRecord(
  sb: SupabaseClient,
  viewer: Viewer,
  recordId: string,
): Promise<{ view: RecordView; row: SubmissionRow } | null> {
  const q = await sb
    .from("submissions")
    .select("id, module, action_type, status, submitted_at, admin_action_at, submitter_worker_id, person_worker_id, notes, payload")
    .eq("id", recordId)
    .maybeSingle();
  if (q.error || !q.data) return null;
  const row = q.data as SubmissionRow;

  const payload = parsePayload(row.payload);
  const kind = kindFromModule(row.module);
  const action_label = labelForAction(row.module, row.action_type);
  const route = routeFor(row.action_type);

  // Resolve sender + person display names.
  const ids = new Set<string>();
  if (row.submitter_worker_id) ids.add(row.submitter_worker_id);
  if (row.person_worker_id) ids.add(row.person_worker_id);
  const idList = Array.from(ids);
  const nameByWorker = new Map<string, string>();
  if (idList.length > 0) {
    const pQ = await sb
      .from("people")
      .select("worker_id, display_name")
      .in("worker_id", idList);
    for (const p of pQ.data ?? []) nameByWorker.set(p.worker_id as string, (p.display_name as string | null) ?? "");
  }
  const senderName = row.submitter_worker_id
    ? (nameByWorker.get(row.submitter_worker_id) ?? "")
    : "";
  const personName = row.person_worker_id
    ? (nameByWorker.get(row.person_worker_id) ?? "")
    : "";

  // Eyebrow + title.
  const eyebrow =
    kind === "incident" ? "Incident Report" :
    kind === "hire" ? "New Hire" :
    `PAF · ${action_label}`;

  // Title mirrors the inbox row: travel-self shows "<club> · <dates>",
  // new hire shows "<first> <last>", otherwise the person's name.
  function titleOf(): string {
    const isSelfTravel = row.submitter_worker_id === viewer.worker_id
      && row.action_type === "travel_reimbursement"
      && (row.person_worker_id === null || row.person_worker_id === viewer.worker_id);
    if (isSelfTravel) {
      const loc = String(payload.locationName ?? "").trim();
      const start = String(payload.travelStartDate ?? "").trim();
      const end = String(payload.travelEndDate ?? "").trim();
      const dates = start && end ? `${fmtShort(start)} - ${fmtShort(end)}` : start ? fmtShort(start) : end ? fmtShort(end) : "";
      const parts = [loc, dates].filter(Boolean);
      if (parts.length) return parts.join(" · ");
    }
    if (kind === "hire") {
      const first = String(payload.firstName ?? "").trim();
      const last = String(payload.lastName ?? "").trim();
      const both = [first, last].filter(Boolean).join(" ");
      if (both) return both;
    }
    if (personName) return personName;
    const en = String(payload.employeeName ?? "").trim();
    if (en) return en;
    return eyebrow;
  }

  const detail = detailPairs(row.module, row.action_type, payload, personName || null);

  // Sender's note lives in payload.explanation when the form has one.
  // The render masked it, but per T3 ruling we show it for real
  // because only the approved viewers reach this loader.
  const sender_note = String(payload.explanation ?? "").trim();
  // Rejection reason: submissions.notes is written by the admin on
  // reject; only shown when status is Rejected.
  const rejection_reason = row.status === "Rejected"
    ? String(row.notes ?? "").replace(/^\[.*?\]\s*/, "").trim()
    : "";

  // Build the ledger. Prefer submission_events when present; else
  // sent + decision lines.
  const evQ = await sb
    .from("submission_events")
    .select("id, at, kind, actor_worker_id, note")
    .eq("submission_id", recordId)
    .order("at", { ascending: true });
  const evRows = (evQ.data ?? []) as Array<{ id: string; at: string; kind: string; actor_worker_id: string | null; note: string | null }>;

  const ledger: RecordView["ledger"] = [];
  if (evRows.length > 0) {
    // Resolve actor names for the events.
    const actorIds = Array.from(new Set(evRows.map((e) => e.actor_worker_id).filter(Boolean))) as string[];
    const actorByWorker = new Map<string, string>();
    if (actorIds.length > 0) {
      const aQ = await sb.from("people").select("worker_id, display_name").in("worker_id", actorIds);
      for (const a of aQ.data ?? []) actorByWorker.set(a.worker_id as string, (a.display_name as string | null) ?? "");
    }
    for (const e of evRows) {
      const actor = e.actor_worker_id ? (actorByWorker.get(e.actor_worker_id) ?? "") : "";
      const tone: RecordView["ledger"][number]["tone"] =
        e.kind === "approved" ? "good" :
        e.kind === "rejected" ? "warn" :
        e.kind === "withdrawn" ? "muted" :
        "info";
      ledger.push({
        tone,
        what: e.kind.charAt(0).toUpperCase() + e.kind.slice(1),
        means: [actor ? `By ${actor}` : "", (e.note ?? "").trim()].filter(Boolean).join(" · "),
        when: fmtFull(e.at),
      });
    }
  } else {
    // Sent line (always present when submitted_at is set).
    if (row.submitted_at) {
      // The old data does not record decider; do not name anyone.
      ledger.push({
        tone: "info",
        what: `Sent to ${route}`,
        means: senderName ? `By ${senderName}` : "",
        when: fmtFull(row.submitted_at),
      });
    }
    // Decision line (when admin_action_at is set and status is a
    // final state).
    if (row.admin_action_at && row.status && row.status !== "Pending") {
      const word = statusDisplay(row.status);
      const tone: RecordView["ledger"][number]["tone"] =
        row.status === "Complete" ? "good" :
        row.status === "Rejected" ? "warn" :
        "muted";
      ledger.push({
        tone,
        what: word,
        // Keep deliberately bare: the old table did not record who
        // decided, so claiming a name would be wrong.
        means: "",
        when: fmtFull(row.admin_action_at),
      });
    }
    // Keep chronological order (sent first, decision second).
    ledger.reverse();
  }

  const view: RecordView = {
    id: row.id,
    kind,
    eyebrow,
    title: titleOf(),
    status_display: statusDisplay(row.status),
    status_code: (row.status ?? "Pending"),
    detail,
    sender_note,
    rejection_reason,
    ledger,
  };
  return { view, row };
}

// Mark a record as opened for this viewer. Idempotent (viewer +
// kind + id is the natural key; a second insert is a no-op via
// upsert). Caller MUST pass isPreview === false; see page.tsx.
export async function markOpened(
  sb: SupabaseClient,
  viewerWorkerId: string,
  recordId: string,
): Promise<void> {
  // on-conflict ignored would be ideal; without a named constraint
  // we check-then-insert. Race is harmless: the duplicate just
  // returns an error we swallow.
  const already = await sb
    .from("people_record_opens")
    .select("record_id")
    .eq("viewer_worker_id", viewerWorkerId)
    .eq("record_kind", "submission")
    .eq("record_id", recordId)
    .maybeSingle();
  if (already.data) return;
  const ins = await sb.from("people_record_opens").insert({
    viewer_worker_id: viewerWorkerId,
    record_kind: "submission",
    record_id: recordId,
  });
  if (ins.error) {
    // Swallow unique-violation (concurrent open); rethrow anything
    // else so a real failure surfaces in the loader.
    if (!/duplicate|unique/i.test(ins.error.message)) throw new Error(`[people/markOpened] insert: ${ins.error.message}`);
  }
}
