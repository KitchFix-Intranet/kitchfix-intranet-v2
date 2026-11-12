// Inbox loader. Server-only. Produces an `InboxView` for the viewer:
//
//   - mine[]: rows the viewer sent (submitter_worker_id === viewer)
//   - team[]: rows about someone in the viewer's team (SL + RD only).
//             About my team excludes mine and excludes rows about the
//             viewer themselves (R-PP21 self-by-other rule).
//   - band: banner title, phone head line, counts (drive `mine` only).
//
// No request payload crosses the server boundary through this file:
// the InboxRow type carries pre-rendered strings only. Payload parsing
// for the detail drawer lives in loadRecord.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer, AccountRow } from "./types";
import type {
  InboxRow, InboxBand, InboxKind, InboxView, InboxGroup,
} from "./inboxTypes";
import { labelForAction, routeFor } from "./labels";
import { LATE_DAYS } from "./thresholds";
import { fmtShort, fmtFull } from "./dates";
import { fmtMoney } from "./money";

// A submissions row shape, after a narrow server-side SELECT. The
// payload is a TEXT column holding one JSON object; parse once per
// row, tolerating bad JSON.
interface SubmissionRow {
  id: string;
  module: string | null;
  action_type: string | null;
  status: "Pending" | "Complete" | "Rejected" | "Withdrawn" | "Cancelled" | null;
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

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

// R-PP7 word mapping. Complete -> "Approved"; Cancelled -> "Withdrawn";
// Pending stays "Pending"; Rejected and Withdrawn pass through.
function statusDisplay(status: SubmissionRow["status"]): string {
  if (status === "Complete") return "Approved";
  if (status === "Cancelled") return "Withdrawn";
  return status ?? "Pending";
}

function kindFromModule(m: string | null): InboxKind {
  const s = (m ?? "").toLowerCase();
  if (s === "paf") return "paf";
  if (s === "newhire") return "hire";
  if (s === "incident") return "incident";
  return "paf";
}

function kindWord(k: InboxKind): string {
  if (k === "paf") return "PAF";
  if (k === "hire") return "New Hire";
  return "Incident";
}

// bucket() - R-PP21 inbox groups. Rules:
//   - Needs you: Rejected + unread; or Pending for >= LATE_DAYS.
//   - Just decided: Approved OR Withdrawn OR Cancelled, and unread.
//   - Pending: everything else still Pending.
//   - Earlier: the rest.
function bucketOf(status: SubmissionRow["status"], unread: boolean, ageDays: number): InboxGroup {
  if (status === "Rejected" && unread) return "needs";
  if (status === "Pending" && ageDays >= LATE_DAYS) return "needs";
  if ((status === "Complete" || status === "Withdrawn" || status === "Cancelled") && unread) return "news";
  if (status === "Pending") return "pending";
  return "earlier";
}

// "why" text on the Needs you row. Mirrors the render's whyOf():
//   - Rejected: "Rejected · see why"
//   - Pending-late: "<age> days with HR" / "<age> days with finance"
function whyTextOf(status: SubmissionRow["status"], action_type: string | null, ageDays: number): string {
  if (status === "Rejected") return "Rejected · see why";
  if (status === "Pending") return `${ageDays} days with ${routeFor(action_type)}`;
  return "";
}

// Title: for a travel reimbursement the viewer sent for themselves,
// show "<club> · <dates>" (the trip, not the person - the person is
// the viewer). Otherwise show the person's name (`employeeName`, or
// first + last for a new hire). Falls back to the module word.
function titleOf(
  row: SubmissionRow,
  payload: Record<string, unknown>,
  viewer: Viewer,
  kind: InboxKind,
): string {
  const isSelfTravel = row.submitter_worker_id === viewer.worker_id
    && row.action_type === "travel_reimbursement"
    && (row.person_worker_id === null || row.person_worker_id === viewer.worker_id);
  if (isSelfTravel) {
    const loc = String(payload.locationName ?? "").trim();
    const start = String(payload.travelStartDate ?? "").trim();
    const end = String(payload.travelEndDate ?? "").trim();
    const dates = start && end
      ? `${fmtShort(start)} - ${fmtShort(end)}`
      : start ? fmtShort(start) : end ? fmtShort(end) : "";
    const parts = [loc, dates].filter(Boolean);
    if (parts.length) return parts.join(" · ");
  }
  if (kind === "hire") {
    const first = String(payload.firstName ?? "").trim();
    const last = String(payload.lastName ?? "").trim();
    const both = [first, last].filter(Boolean).join(" ");
    if (both) return both;
  }
  const name = String(payload.employeeName ?? "").trim();
  if (name) return name;
  return kindWord(kind);
}

// Subline tail: trip length for travel; site for others; "job · site"
// for new hire.
function sublineTail(row: SubmissionRow, payload: Record<string, unknown>, kind: InboxKind): string {
  const bits: string[] = [];
  if (kind === "hire") {
    const job = String(payload.jobTitle ?? "").trim();
    if (job) bits.push(job);
    const op = String(payload.operation ?? payload.locationName ?? "").trim();
    if (op) bits.push(op);
    return bits.join(" · ");
  }
  if (row.action_type === "travel_reimbursement") {
    const days = Number(payload.travelTotalDays);
    if (Number.isFinite(days) && days > 0) bits.push(`${days} day${days === 1 ? "" : "s"} away`);
    const loc = String(payload.locationName ?? "").trim();
    if (loc) bits.push(loc);
    return bits.join(" · ");
  }
  const loc = String(payload.locationName ?? "").trim();
  if (loc) bits.push(loc);
  return bits.join(" · ");
}

function amountOf(row: SubmissionRow, payload: Record<string, unknown>): string {
  if (row.action_type === "travel_reimbursement") return fmtMoney(payload.perDiemTotal ?? payload.travelGrandTotal);
  const withAmount: ReadonlySet<string> = new Set([
    "add_bonus", "add_deduction", "other_reimbursement", "add_cell_phone",
  ]);
  if (row.action_type && withAmount.has(row.action_type)) return fmtMoney(payload.amount);
  return "";
}

// Build an InboxRow from a submission. `unread` is already computed
// from people_record_opens; `senderName` is looked up once per batch.
function toInboxRow(
  row: SubmissionRow,
  viewer: Viewer,
  unread: boolean,
  now: Date,
  senderName: string,
): InboxRow {
  const payload = parsePayload(row.payload);
  const kind = kindFromModule(row.module);
  const action_label = labelForAction(row.module, row.action_type);
  const title_base = titleOf(row, payload, viewer, kind);
  const tail = sublineTail(row, payload, kind);
  const isAboutMyTeam = row.submitter_worker_id !== viewer.worker_id;
  const subline = [
    kindWord(kind),
    action_label,
    tail,
    isAboutMyTeam && senderName ? `by ${senderName}` : "",
  ].filter(Boolean).join(" · ");
  const ageDays = daysSince(row.submitted_at, now);
  const status_display = statusDisplay(row.status);
  const group = bucketOf(row.status, unread, ageDays);
  const why_text = group === "needs" ? whyTextOf(row.status, row.action_type, ageDays) : "";
  return {
    id: row.id,
    kind,
    title: title_base,
    subline,
    amount_display: amountOf(row, payload),
    status_display,
    status_code: (row.status ?? "Pending"),
    sent_short: fmtShort(row.submitted_at),
    sent_long: fmtFull(row.submitted_at),
    decided_short: row.admin_action_at ? fmtShort(row.admin_action_at) : null,
    decided_long: row.admin_action_at ? fmtFull(row.admin_action_at) : null,
    unread,
    group,
    why_text,
    route: routeFor(row.action_type),
    sender_name: senderName,
    action_label,
  };
}

function bandFor(mine: InboxRow[]): InboxBand {
  const needs = mine.filter((r) => r.group === "needs").length;
  const news = mine.filter((r) => r.group === "news").length;
  const pending = mine.filter((r) => r.group === "pending").length
    + mine.filter((r) => r.group === "needs" && r.status_code === "Pending").length;
  let title: string;
  if (needs > 0) title = `${needs} ${needs === 1 ? "needs you" : "need you"}`;
  else if (mine.length > 0) title = "All caught up";
  else title = "Nothing here yet";
  let phone_line: string;
  if (mine.length === 0) phone_line = "Nothing sent yet";
  else phone_line = `${needs > 0 ? `${needs} ${needs === 1 ? "needs you" : "need you"}` : "All caught up"} · ${pending} pending`;
  return { title, phone_line, pending_count: pending, news_count: news, needs_count: needs };
}

// Public entry point.
export async function loadInbox(sb: SupabaseClient, viewer: Viewer): Promise<InboxView> {
  const now = new Date();

  // 1. All submissions. Narrow the projection to the fields we need.
  const subQ = await sb
    .from("submissions")
    .select("id, module, action_type, status, submitted_at, admin_action_at, submitter_worker_id, person_worker_id, notes, payload")
    .order("submitted_at", { ascending: false });
  if (subQ.error) throw new Error(`[people/loadInbox] submissions: ${subQ.error.message}`);
  const rows = (subQ.data ?? []) as SubmissionRow[];

  // 2. Opens map for this viewer. Only the viewer's own opens count
  //    - "unread" is personal.
  const opQ = await sb
    .from("people_record_opens")
    .select("record_id")
    .eq("viewer_worker_id", viewer.worker_id)
    .eq("record_kind", "submission");
  if (opQ.error) throw new Error(`[people/loadInbox] opens: ${opQ.error.message}`);
  const openSet = new Set((opQ.data ?? []).map((o) => o.record_id as string));

  // 3. Sender names (and person account_keys for "About my team"
  //    fallback by locationKey). One fetch each, keyed by worker_id.
  const senderIds = new Set<string>();
  const personIds = new Set<string>();
  for (const r of rows) {
    if (r.submitter_worker_id) senderIds.add(r.submitter_worker_id);
    if (r.person_worker_id) personIds.add(r.person_worker_id);
  }
  const allIds = Array.from(new Set([...senderIds, ...personIds]));
  const senderNameByWorker = new Map<string, string>();
  const personAccountByWorker = new Map<string, string>();
  if (allIds.length > 0) {
    const peopleQ = await sb
      .from("people")
      .select("worker_id, display_name, account_key")
      .in("worker_id", allIds);
    for (const p of peopleQ.data ?? []) {
      senderNameByWorker.set(p.worker_id as string, (p.display_name as string | null) ?? "");
      personAccountByWorker.set(p.worker_id as string, (p.account_key as string | null) ?? "");
    }
  }

  // 4. Accounts for site scope (RD) + the payload fallback by
  //    locationKey when person_worker_id is null.
  const acctQ = await sb.from("accounts").select("team_key, region");
  const accountRegionByKey = new Map<string, string | null>();
  for (const a of (acctQ.data ?? []) as AccountRow[]) {
    accountRegionByKey.set(a.team_key, (a.region as string | null) ?? null);
  }

  // 5. Build the viewer's site scope for About my team.
  //    - SL: one account.
  //    - RD: every non-corporate account in the viewer's region
  //          (NOT corporate; see item spec).
  //    - corporate + null role: no team switch.
  const hasTeamSwitch = viewer.role === "site_leader" || viewer.role === "regional_director";
  const teamSiteKeys = new Set<string>();
  if (viewer.role === "site_leader") {
    teamSiteKeys.add(viewer.account_key);
  } else if (viewer.role === "regional_director") {
    for (const [tk, reg] of accountRegionByKey.entries()) {
      if (reg === viewer.region && reg !== "CORP") teamSiteKeys.add(tk);
    }
  }

  // 6. Split + map rows.
  const mine: InboxRow[] = [];
  const team: InboxRow[] = [];
  for (const row of rows) {
    const unread = !openSet.has(row.id);
    const senderName = row.submitter_worker_id
      ? (senderNameByWorker.get(row.submitter_worker_id) ?? "")
      : "";
    if (row.submitter_worker_id === viewer.worker_id) {
      mine.push(toInboxRow(row, viewer, unread, now, senderName));
      continue;
    }
    if (!hasTeamSwitch) continue;
    // Self-by-other: never surfaces on the viewer's inbox.
    if (row.person_worker_id === viewer.worker_id) continue;
    // About my team requires the person to be in a scope site.
    // Primary signal: person_worker_id -> accounts via people.
    //   Fallback when person_worker_id is null: payload.locationKey.
    let personSite: string | null = null;
    if (row.person_worker_id) {
      personSite = personAccountByWorker.get(row.person_worker_id) ?? null;
    } else {
      const payload = parsePayload(row.payload);
      const lk = String(payload.locationKey ?? "").trim();
      if (lk) personSite = lk;
    }
    if (!personSite || !teamSiteKeys.has(personSite)) continue;
    team.push(toInboxRow(row, viewer, unread, now, senderName));
  }

  // 7. Band is derived from `mine` only.
  const band = bandFor(mine);

  return { hasTeamSwitch, mine, team, band };
}
