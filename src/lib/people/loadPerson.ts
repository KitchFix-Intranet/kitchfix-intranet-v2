// Card loader. Pulls one person + their waiting + their History
// (gated by R-PP54) + their manager name (pin 4 - name only, no
// link or card, even when the manager is out of scope).
//
// Scope enforcement (pin 1, 2026-11-11): the caller MUST verify
// that the requested worker_id is in the viewer's scope BEFORE
// invoking this loader. The page calls `inScope(viewer, row,
// accountRegionByKey)` first; a miss returns `notFound()` from
// the server. This function assumes the gate has passed.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PeopleRow,
  AccountRow,
  Viewer,
  CardPerson,
  HistoryRow,
  InFlightRow,
} from "./types";
import { toCardPerson } from "./contact";
import { fmtShort, fmtFull, fmtDaysWaiting } from "./dates";
import { LATE_DAYS } from "./thresholds";
import { labelForAction } from "./labels";
import { viewerIsInChain } from "./chain";

const PERSON_SELECT =
  "worker_id, display_name, title, account_key, region, work_email, personal_email, phone, manager_worker_id, start_date, birthday, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status";

// Manager display name, walked up the chain only once (pin 4:
// name only). Guarded against the degenerate self-manager and
// cycle cases: a seen-set tracks visited worker_ids so a bad row
// cannot send us into a loop.
async function resolveManagerName(
  sb: SupabaseClient,
  rootManagerId: string | null,
): Promise<string | null> {
  if (!rootManagerId) return null;
  const seen = new Set<string>();
  let current: string | null = rootManagerId;
  // One hop today ("Reports to"). The seen-set is defensive so an
  // operator extending this to walk the chain cannot accidentally
  // loop on a self-manager row (manager_worker_id === worker_id)
  // or a longer cycle.
  while (current && !seen.has(current)) {
    seen.add(current);
    const q = await sb
      .from("people")
      .select("worker_id, display_name")
      .eq("worker_id", current)
      .maybeSingle();
    if (q.error || !q.data) return null;
    return (q.data.display_name as string | null) ?? null;
  }
  return null;
}

// History visibility (R-PP54). The viewer may see the person's
// History if any of these are true:
//   - viewer has pp_full_access or pp_review
//   - the person reports to the viewer directly or further up
//   - the viewer sent the row (then only their own rows)
// Nobody sees History rows about themselves that someone else sent.
async function visibleHistory(
  sb: SupabaseClient,
  viewer: Viewer,
  person: PeopleRow,
  todayYear: number,
): Promise<{ visible: boolean; rows: HistoryRow[] }> {
  // R-PP54 gate. Three grant branches, one narrowing rule:
  //   - grant_full:    viewer has pp_full_access or pp_review
  //   - grant_reports: person reports to the viewer directly or
  //                    transitively (chain walk, seen-set guarded
  //                    against cycles; self-manager / A->B->A).
  //   - grant_sent:    viewer sent the row (always available;
  //                    narrows to only-own-sent rows).
  // "Everyone else gets the waiting state and no History section."
  // "Nobody sees History rows about themselves that someone else
  // sent." The second rule narrows the result set when viewing self.
  const isSelf = person.worker_id === viewer.worker_id;
  const grant_full = viewer.pp_full_access || viewer.pp_review;

  // T3 (2026-11-13). Chain walk extracted to src/lib/people/chain.ts
  // so loadRecord.ts (Inbox record drawer) can use it too.
  const grant_reports = isSelf
    ? false
    : await viewerIsInChain(sb, viewer.worker_id, person.manager_worker_id);

  // Build the query. Narrow to viewer-sent rows when either:
  //   (a) no full/reports grant applies - the only way the viewer
  //       may see any History at all is through what they sent.
  //   (b) viewing self - the second half of R-PP54 keeps a self
  //       from seeing rows a third party filed about them.
  const needsSelfFilter = !grant_full && !grant_reports;
  const needsSelfOwnOnly = isSelf;

  const FINAL = ["Complete", "Rejected", "Withdrawn", "Cancelled"] as const;
  let q = sb
    .from("submissions")
    .select("id, module, action_type, submitted_at, submitter_worker_id, status")
    .eq("person_worker_id", person.worker_id)
    .in("status", FINAL as unknown as string[])
    .gte("submitted_at", `${todayYear}-01-01T00:00:00Z`)
    .lte("submitted_at", `${todayYear}-12-31T23:59:59Z`)
    .order("submitted_at", { ascending: false });
  if (needsSelfFilter || needsSelfOwnOnly) {
    q = q.eq("submitter_worker_id", viewer.worker_id);
  }

  const rowsQ = await q;
  if (rowsQ.error) return { visible: grant_full || grant_reports, rows: [] };
  const rows = (rowsQ.data ?? []) as Array<{
    id: string; module: string | null; action_type: string | null;
    submitted_at: string; submitter_worker_id: string | null; status: string;
  }>;

  // Visibility: full / reports grants always render the section
  // (even with zero rows). Without them, the viewer only sees the
  // section if they actually sent at least one row.
  const visible = grant_full || grant_reports || rows.length > 0;
  if (!visible) return { visible: false, rows: [] };

  // Submitter name resolution (one extra query).
  const submitterIds = Array.from(new Set(rows.map((r) => r.submitter_worker_id).filter(Boolean))) as string[];
  const submitterNames = new Map<string, string>();
  if (submitterIds.length > 0) {
    const sQ = await sb.from("people").select("worker_id, display_name").in("worker_id", submitterIds);
    if (!sQ.error) for (const s of sQ.data ?? []) submitterNames.set(s.worker_id, s.display_name ?? "");
  }

  // R-PP7 word mapping. Three mappings named by spec: Complete reads
  // "Approved"; Cancelled reads "Withdrawn"; Pending reads "Pending".
  // Rejected and Withdrawn pass through as-is (they already read as
  // the spec requires).
  const statusDisplay = (status: string): string => {
    if (status === "Complete") return "Approved";
    if (status === "Cancelled") return "Withdrawn";
    if (status === "Pending") return "Pending";
    return status;
  };

  const historyRows: HistoryRow[] = rows.map((r) => ({
    id: r.id,
    action: labelForAction(r.module, r.action_type),
    date: r.submitted_at,
    dateLong: fmtFull(r.submitted_at),
    submitter_name: submitterNames.get(r.submitter_worker_id ?? "") ?? "",
    status_display: statusDisplay(r.status),
  }));

  return { visible: true, rows: historyRows };
}

// Tenure line + anniversary line from start_date. No "N days ago"
// (pin 5). "1 year with KitchFix" / "3 years with KitchFix" etc.
function tenureStrings(start_date: string | null | undefined, now: Date = new Date()): {
  started_full: string | null;
  tenure_line: string | null;
  anniversary_line: string | null;
} {
  if (!start_date) return { started_full: null, tenure_line: null, anniversary_line: null };
  const parts = start_date.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return { started_full: null, tenure_line: null, anniversary_line: null };
  const sy = parseInt(parts[1], 10);
  const sm = parseInt(parts[2], 10);
  const sd = parseInt(parts[3], 10);
  // Integer years, floored. Birthdays excluded by spec, so the
  // tenure only lands when the anniversary month/day has passed.
  const ty = now.getFullYear();
  const tm = now.getMonth() + 1;
  const td = now.getDate();
  let years = ty - sy;
  if (tm < sm || (tm === sm && td < sd)) years -= 1;
  const tenure_line =
    years <= 0 ? "Less than a year with KitchFix" :
    years === 1 ? "1 year with KitchFix" :
    `${years} years with KitchFix`;
  // Next anniversary (month/day) falls in either this year or
  // next year depending on whether it has already passed.
  const anniv_year = (tm < sm || (tm === sm && td < sd)) ? ty : ty + 1;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const anniversary_line = `Next anniversary ${MONTHS[sm - 1]} ${sd}, ${anniv_year}`;
  return {
    started_full: fmtFull(start_date),
    tenure_line,
    anniversary_line,
  };
}

function kindFromModule(m: string | null): InFlightRow["kind"] {
  const s = (m ?? "").toLowerCase();
  if (s === "paf") return "paf";
  if (s === "incident") return "incident";
  if (s === "termination") return "termination";
  return "other";
}
function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

// T2.2 (2026-11-12). "Started" one-liner for the card: date · tenure ·
// "N on Mon D" next-anniversary clause. Example:
// "May 18, 2026 · 5 months · 1 year on May 18".
function startedOneLine(start_date: string | null | undefined, now: Date = new Date()): string | null {
  if (!start_date) return null;
  const parts = start_date.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return null;
  const sy = parseInt(parts[1], 10);
  const sm = parseInt(parts[2], 10);
  const sd = parseInt(parts[3], 10);
  const dateStr = fmtFull(start_date);

  // Months + years since start.
  const ty = now.getFullYear();
  const tm = now.getMonth() + 1;
  const td = now.getDate();
  let months = (ty - sy) * 12 + (tm - sm);
  if (td < sd) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const tenure =
    years === 0 && remMonths === 0 ? "less than a month" :
    years === 0 ? `${remMonths} month${remMonths === 1 ? "" : "s"}` :
    years === 1 && remMonths === 0 ? "1 year" :
    years === 1 ? `1 year, ${remMonths} month${remMonths === 1 ? "" : "s"}` :
    remMonths === 0 ? `${years} years` :
    `${years} years, ${remMonths} month${remMonths === 1 ? "" : "s"}`;

  // Next anniversary: "1 year on May 18" (years = full years + 1 if
  // the anniversary has not yet landed this year, else + 1 for next
  // year's).
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const anniversaryNotYetThisYear = tm < sm || (tm === sm && td < sd);
  const nextYears = anniversaryNotYetThisYear ? (ty - sy) : (ty - sy + 1);
  const nextLabel =
    nextYears === 1 ? "1 year" :
    `${nextYears} years`;
  const nextAnniv = `${nextLabel} on ${MONTHS[sm - 1]} ${sd}`;

  return `${dateStr} · ${tenure} · ${nextAnniv}`;
}

export async function loadPerson(
  sb: SupabaseClient,
  viewer: Viewer,
  workerId: string,
): Promise<{ person: CardPerson; row: PeopleRow } | null> {
  const q = await sb
    .from("people")
    .select(PERSON_SELECT)
    .eq("status", "ACTIVE")
    .eq("worker_id", workerId)
    .maybeSingle();
  if (q.error || !q.data) return null;
  const row = q.data as PeopleRow;

  // Account for region + name display + city/state.
  const accQ = await sb
    .from("accounts")
    .select("team_key, name, region, city, state")
    .eq("team_key", row.account_key)
    .maybeSingle();
  const account_region = (accQ.data?.region as string | null) ?? null;
  const acctName = ((accQ.data?.name as string | null) ?? "").trim();
  const city = ((accQ.data?.city as string | null) ?? "").trim();
  const state = ((accQ.data?.state as string | null) ?? "").trim();
  const city_state = city && state ? `${city}, ${state}` : city || row.account_key;

  // Waiting for this person (full list - used by the In flight table).
  const wQ = await sb
    .from("submissions")
    .select("id, module, action_type, submitted_at, submitter_worker_id")
    .eq("status", "Pending")
    .eq("person_worker_id", workerId)
    .neq("module", "newhire")
    .order("submitted_at", { ascending: false });
  const wRows = wQ.data ?? [];
  let waiting_count = 0;
  const now = new Date();
  const inFlightRows: InFlightRow[] = [];

  if (wRows.length > 0) {
    waiting_count = wRows.length;
    // Resolve submitter names once.
    const subIds = Array.from(new Set(wRows.map((r) => r.submitter_worker_id).filter(Boolean))) as string[];
    const subNames = new Map<string, string>();
    if (subIds.length > 0) {
      const sQ = await sb.from("people").select("worker_id, display_name").in("worker_id", subIds);
      if (!sQ.error) for (const s of sQ.data ?? []) subNames.set(s.worker_id, s.display_name ?? "");
    }
    for (const r of wRows) {
      const d = daysSince((r.submitted_at ?? "") as string, now);
      inFlightRows.push({
        id: (r.id ?? "") as string,
        kind: kindFromModule(r.module as string | null),
        label: labelForAction(r.module as string | null, r.action_type as string | null),
        submitter_name: subNames.get((r.submitter_worker_id as string) ?? "") ?? null,
        sent_short: fmtShort((r.submitted_at ?? "") as string),
        wait_days: fmtDaysWaiting((r.submitted_at ?? "") as string, now),
        late: d >= LATE_DAYS,
      });
    }
  }

  // Manager name (pin 4).
  const manager_name = await resolveManagerName(sb, row.manager_worker_id);

  // Tenure strings (T2 compat + T2.2 one-liner).
  const t = tenureStrings(row.start_date);
  const started_line = startedOneLine(row.start_date);

  // History + visibility. T2.2: In flight uses the SAME visibility rule.
  const hist = await visibleHistory(sb, viewer, row, now.getFullYear());
  const inFlightVisible = hist.visible;

  // T2.2.1 (2026-11-12). Restricted-viewer notes: one short sentence
  // per pending request. Rendered instead of the In flight rows when
  // the viewer may not open the request (R-PP54). State only - no
  // amounts, no notes, no other fields.
  //
  // Sender fallback: when submitter_name is unknown, read "sent by
  // someone" rather than leaking a worker_id or empty " by ,".
  const inFlightNotes: string[] =
    inFlightVisible || inFlightRows.length === 0
      ? []
      : inFlightRows.map((r) => {
          const sender = r.submitter_name && r.submitter_name.trim()
            ? r.submitter_name
            : "someone";
          return `${r.label} sent by ${sender}, waiting ${r.wait_days}. Only the sender, their manager chain, HR and finance can open it.`;
        });

  // Eyebrow, title suffix, role/site display strings for the card
  // chrome (T2.2 render shape).
  const eyebrow = acctName || row.account_key;
  const title_suffix = row.worker_id === viewer.worker_id ? " (you)" : "";
  const roleSuffix = row.is_site_leader
    ? " · site leader"
    : row.is_regional_director
      ? " · regional director"
      : "";
  const role_display = ((row.title ?? "").trim() || "No role") + roleSuffix;
  const site_display = (acctName || row.account_key) + " · " + city_state;

  return {
    row,
    person: toCardPerson({
      row,
      account_region,
      waiting_count,
      manager_name,
      started_full: t.started_full,
      tenure_line: t.tenure_line,
      anniversary_line: t.anniversary_line,
      historyVisible: hist.visible,
      history: hist.rows,
      eyebrow,
      title_suffix,
      role_display,
      site_display,
      started_line,
      inFlightVisible,
      inFlightCount: waiting_count,
      inFlightRows: inFlightVisible ? inFlightRows : [],
      inFlightNotes,
    }),
  };
}
