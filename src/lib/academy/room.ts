// src/lib/academy/room.ts
//
// Loader for /api/academy/room. Returns the room's JSON shape in a
// pure function of (email, serviceClient). The route handler is a
// thin wrapper over this; the parity script also calls this directly.
//
// Shape:
//   - viewer           identity summary (no PII) + viewer record tiles
//   - queue            viewer's academy_requirements enriched with doc
//                      title, shelf, obligation.source_section, cycle label
//   - queueSummary     { count, totalMinutes, remaining, percent }
//   - yearTrack        12 month cells for the current calendar year
//   - nextCycle        first published cycle whose period_start > today
//   - companyStanding  present only when scope.kind is 'company' or 'region'
//
// READ-ONLY. No writes, no mutations, no PII on the wire.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity, eligibleCountInScope } from "./identity";
import type { AcademyIdentity, EligibleCounts } from "./identity";

export type RoomResult =
  | {
      ok: false;
      status: 401 | 404 | 500;
      error: string;
      scope?: string;
      detail?: string;
    }
  | ({
      ok: true;
    } & RoomBody);

export interface RoomBody {
  viewer: {
    workerId: string;
    personId: string | null;
    displayName: string | null;
    roleTitle: string | null;
    accountKey: string | null;
    region: string | null;
    isSalaried: boolean;
    isSiteLeader: boolean;
    isCorp: boolean;
    scope: AcademyIdentity["scope"];
    grants: AcademyIdentity["grants"];
    eligibleInScope: EligibleCounts;
    record: {
      signedAllTime: number;
      minutesReadThisCycle: number;
      checksPassed: number;
      retries: number;
      cyclesClosedCount: number;
      firstRun: boolean;
    };
  };
  queue: QueueItem[];
  queueSummary: {
    count: number;
    signedCount: number;
    remainingCount: number;
    totalMinutes: number;
    totalMinutesRemaining: number;
    percentCurrent: number | null;
  };
  yearTrack: YearCell[];
  nextCycle: {
    cycle_id: string | number;
    label: string;
    period_start: string;
    period_end: string;
  } | null;
  companyStanding: CompanyStanding | null;
}

export interface QueueItem {
  requirement_id: string | number;
  doc_id: string;
  doc_title: string;
  doc_shelf: string | null;
  doc_class: string | null;
  obligation_key: string;
  part_number: number;
  total_parts: number;
  source_section: string | null;
  cadence: string | null;
  obligation_type: string | null;
  description: string | null;
  card_line: string | null;
  doc_version: string | number | null;
  est_minutes: number;
  due_date: string | null;
  source: string | null;
  cycle_id: string | number | null;
  cycle_label: string | null;
  signed: boolean;
  signed_at: string | null;
  certificate_serial: string | null;
  attestation_id: string | number | null;
}

export interface YearCell {
  month: string;
  label: string;
  monthName: string;
  isCurrentMonth: boolean;
  hasCycle: boolean;
  cycleId: string | number | null;
  cycleStatus: string | null;
  cycleLabel: string | null;
}

export interface StandingAccount {
  team_key: string;
  region: string | null;
  eligible: number;
  enrolled: number;
  notEnrolled: number;
  people: Array<{
    worker_id: string;
    display_name: string | null;
    is_salaried: boolean;
    status: "signed" | "in_progress" | "not_enrolled";
  }>;
  aggregateHourly: number;
  standing: "unstaffed" | "not_enrolled" | "in_progress";
}

export interface CompanyStanding {
  accounts: StandingAccount[];
  totals: {
    accounts: number;
    eligible: number;
    enrolled: number;
    notEnrolled: number;
  };
  currentCycle: {
    cycle_id: string | number;
    label: string;
    period_start: string;
    period_end: string;
    status: string;
    audience_scope: Record<string, unknown>;
  } | null;
  legend: Record<string, string>;
}

interface CycleRow {
  cycle_id: string | number;
  label: string;
  period_start: string | null;
  period_end: string | null;
  status: string | null;
  fiscal_year?: number | null;
  fiscal_period_no?: number | null;
  audience_scope?: Record<string, unknown> | null;
  published_at?: string | null;
}

function buildYearTrack(cycles: CycleRow[], today: Date): YearCell[] {
  const year = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth();
  const labels = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const byMonth = new Map<string, CycleRow>();
  for (const c of cycles) {
    if (!c.period_start) continue;
    const [y, m] = c.period_start.split("-").map(Number);
    if (y === year) {
      const key = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
      byMonth.set(key, c);
    }
  }

  const cells: YearCell[] = [];
  for (let i = 0; i < 12; i += 1) {
    const key = `${String(year).padStart(4, "0")}-${String(i + 1).padStart(2, "0")}`;
    const c = byMonth.get(key) || null;
    cells.push({
      month: key,
      label: labels[i],
      monthName: monthNames[i],
      isCurrentMonth: i === todayMonth,
      hasCycle: !!c,
      cycleId: c?.cycle_id ?? null,
      cycleStatus: c?.status || null,
      cycleLabel: c?.label || null,
    });
  }
  return cells;
}

export async function loadRoom(email: string, supaIn?: SupabaseClient): Promise<RoomResult> {
  const supa = supaIn || serviceClient();

  let identity: AcademyIdentity | null;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadRoom] resolve threw:", msg);
    return { ok: false, status: 500, error: "server_error", scope: "identity" };
  }
  if (!identity) {
    return {
      ok: false,
      status: 404,
      error: "no_roster_row",
      detail: "signed-in email resolved to no active people row",
    };
  }

  const reqsQ = await supa
    .from("academy_requirements")
    .select(
      "requirement_id, worker_id, person_id, doc_id, obligation_key, doc_version, est_minutes, source, cycle_id, due_date, issued_at"
    )
    .eq("worker_id", identity.workerId)
    .is("waived_at", null)
    .order("due_date", { ascending: true })
    .order("doc_id", { ascending: true })
    .order("obligation_key", { ascending: true });
  if (reqsQ.error) {
    console.error("[academy/loadRoom] requirements:", reqsQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "requirements" };
  }
  type ReqRow = {
    requirement_id: string | number;
    worker_id: string;
    person_id: string | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    source: string | null;
    cycle_id: string | number | null;
    due_date: string | null;
    issued_at: string | null;
  };
  let reqs: ReqRow[] = (reqsQ.data as ReqRow[]) || [];

  const distinctDocIds = [...new Set(reqs.map((r) => r.doc_id).filter(Boolean))];
  const distinctCycleIds = [
    ...new Set(reqs.map((r) => r.cycle_id).filter((x): x is string | number => x != null)),
  ];

  const [
    docsQ,
    obligationsQ,
    cyclesQ,
    cycleModulesQ,
    attestationsQ,
    viewerAttemptsQ,
    viewerProgressQ,
  ] = await Promise.all([
    distinctDocIds.length > 0
      ? supa
          .from("documents")
          .select("id, title, shelf, doc_class, version, card_line")
          .in("id", distinctDocIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    distinctDocIds.length > 0
      ? supa
          .from("academy_obligations")
          .select(
            "doc_id, obligation_key, source_section, description, type, cadence, est_minutes, applies_to"
          )
          .in("doc_id", distinctDocIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    supa
      .from("academy_cycles")
      .select(
        "cycle_id, label, period_start, period_end, status, fiscal_year, fiscal_period_no, audience_scope, published_at"
      )
      .order("period_start", { ascending: true }),
    distinctCycleIds.length > 0
      ? supa
          .from("academy_cycle_modules")
          .select("cycle_id, doc_id, obligation_key, sort_order")
          .in("cycle_id", distinctCycleIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    supa
      .from("academy_attestations")
      .select(
        "attestation_id, requirement_id, doc_id, obligation_key, doc_version, signed_at, certificate_serial, supersedes"
      )
      .eq("worker_id", identity.workerId)
      .order("signed_at", { ascending: false }),
    supa
      .from("academy_check_attempts")
      .select("attempt_id, correct")
      .eq("worker_id", identity.workerId),
    supa
      .from("academy_module_progress")
      .select("requirement_id, time_spent_seconds")
      .eq("worker_id", identity.workerId),
  ]);
  const errorChecks: Array<[{ error: { message: string } | null }, string]> = [
    [docsQ, "documents"],
    [obligationsQ, "obligations"],
    [cyclesQ, "cycles"],
    [cycleModulesQ, "cycle_modules"],
    [attestationsQ, "attestations"],
    [viewerAttemptsQ, "viewer_attempts"],
    [viewerProgressQ, "viewer_progress"],
  ];
  for (const [q, scope] of errorChecks) {
    if (q.error) {
      console.error(`[academy/loadRoom] ${scope}:`, q.error.message);
      return { ok: false, status: 500, error: "server_error", scope };
    }
  }

  type DocRow = {
    id: string;
    title: string | null;
    shelf: string | null;
    doc_class: string | null;
    version: string | number | null;
    card_line: string | null;
  };
  type ObligationRowRoom = {
    doc_id: string;
    obligation_key: string;
    source_section: string | null;
    description: string | null;
    type: string | null;
    cadence: string | null;
    est_minutes: number | null;
    applies_to: unknown;
  };
  type AttestationRow = {
    attestation_id: string | number;
    requirement_id: string | number | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    signed_at: string | null;
    certificate_serial: string | null;
    supersedes: string | number | null;
  };
  type CycleModuleRow = {
    cycle_id: string | number;
    doc_id: string;
    obligation_key: string;
    sort_order: number | null;
  };

  const docsById = new Map<string, DocRow>();
  for (const d of (docsQ.data as DocRow[]) || []) docsById.set(d.id, d);
  const obligationsByKey = new Map<string, ObligationRowRoom>();
  for (const ob of (obligationsQ.data as ObligationRowRoom[]) || []) {
    obligationsByKey.set(`${ob.doc_id}|${ob.obligation_key}`, ob);
  }
  const cyclesById = new Map<string | number, CycleRow>();
  const cycles = (cyclesQ.data as CycleRow[]) || [];
  for (const c of cycles) cyclesById.set(c.cycle_id, c);

  const cycleModules = (cycleModulesQ.data as CycleModuleRow[]) || [];
  const sortOrderByCycleReq = new Map<string, number>();
  for (const m of cycleModules) {
    sortOrderByCycleReq.set(
      `${m.cycle_id}|${m.doc_id}|${m.obligation_key}`,
      m.sort_order ?? Number.POSITIVE_INFINITY
    );
  }
  const sortOrderForReq = (r: ReqRow): number => {
    if (r.cycle_id == null) return Number.POSITIVE_INFINITY;
    const v = sortOrderByCycleReq.get(`${r.cycle_id}|${r.doc_id}|${r.obligation_key}`);
    return v == null ? Number.POSITIVE_INFINITY : v;
  };
  reqs = [...reqs].sort((a, b) => {
    const so = sortOrderForReq(a) - sortOrderForReq(b);
    if (so !== 0) return so;
    const ad = a.due_date || "";
    const bd = b.due_date || "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
    return String(a.obligation_key || "").localeCompare(String(b.obligation_key || ""));
  });

  const attestationsByReq = new Map<string | number, AttestationRow>();
  for (const att of (attestationsQ.data as AttestationRow[]) || []) {
    if (att.requirement_id != null) attestationsByReq.set(att.requirement_id, att);
  }

  const byDoc = new Map<string, ReqRow[]>();
  for (const r of reqs) {
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []);
    byDoc.get(r.doc_id)!.push(r);
  }
  for (const [, list] of byDoc) {
    list.sort((a, b) => {
      const so = sortOrderForReq(a) - sortOrderForReq(b);
      if (so !== 0) return so;
      return String(a.obligation_key || "").localeCompare(String(b.obligation_key || ""));
    });
  }
  const partIndex = new Map<string | number, { partNumber: number; totalParts: number }>();
  for (const [, list] of byDoc) {
    list.forEach((r, i) => {
      partIndex.set(r.requirement_id, { partNumber: i + 1, totalParts: list.length });
    });
  }

  const queue: QueueItem[] = reqs.map((r) => {
    const doc = docsById.get(r.doc_id) || null;
    const ob = obligationsByKey.get(`${r.doc_id}|${r.obligation_key}`) || null;
    const cyc = r.cycle_id != null ? cyclesById.get(r.cycle_id) || null : null;
    const att = attestationsByReq.get(r.requirement_id) || null;
    const part = partIndex.get(r.requirement_id) || { partNumber: 1, totalParts: 1 };
    return {
      requirement_id: r.requirement_id,
      doc_id: r.doc_id,
      doc_title: doc?.title || r.doc_id,
      doc_shelf: doc?.shelf || null,
      doc_class: doc?.doc_class || null,
      obligation_key: r.obligation_key,
      part_number: part.partNumber,
      total_parts: part.totalParts,
      source_section: ob?.source_section || null,
      cadence: ob?.cadence || null,
      obligation_type: ob?.type || null,
      description: ob?.description || null,
      card_line: doc?.card_line || null,
      doc_version: r.doc_version,
      est_minutes: r.est_minutes || 0,
      due_date: r.due_date,
      source: r.source,
      cycle_id: r.cycle_id,
      cycle_label: cyc?.label || null,
      signed: att != null,
      signed_at: att?.signed_at || null,
      certificate_serial: att?.certificate_serial || null,
      attestation_id: att?.attestation_id ?? null,
    };
  });
  const signedCount = queue.filter((q) => q.signed).length;
  const totalMinutesRemaining = queue
    .filter((q) => !q.signed)
    .reduce((acc, q) => acc + (q.est_minutes || 0), 0);
  const totalMinutes = queue.reduce((acc, q) => acc + (q.est_minutes || 0), 0);
  const queueSummary = {
    count: queue.length,
    signedCount,
    remainingCount: queue.length - signedCount,
    totalMinutes,
    totalMinutesRemaining,
    percentCurrent:
      signedCount > 0 && queue.length > 0
        ? Math.round((signedCount / queue.length) * 100)
        : null,
  };

  const today = new Date();
  const yearTrack = buildYearTrack(cycles, today);

  const _todayISO = today.toISOString().slice(0, 10);
  const nextCycle = (() => {
    const future = cycles
      .filter(
        (c) => c.status === "published" && c.period_start != null && c.period_start > _todayISO
      )
      .sort((a, b) => (a.period_start || "").localeCompare(b.period_start || ""));
    const first = future[0];
    return first
      ? {
          cycle_id: first.cycle_id,
          label: first.label,
          period_start: first.period_start as string,
          period_end: first.period_end as string,
        }
      : null;
  })();

  const viewerAttempts = (viewerAttemptsQ.data as Array<{ correct: boolean | null }>) || [];
  const viewerProgress =
    (viewerProgressQ.data as Array<{ time_spent_seconds: number | null }>) || [];
  const checksPassed = viewerAttempts.filter((a) => a.correct).length;
  const retries = Math.max(0, viewerAttempts.length - checksPassed);
  const secondsRead = viewerProgress.reduce(
    (acc, r) => acc + (r.time_spent_seconds || 0),
    0
  );
  const minutesRead = secondsRead > 0 ? Math.max(1, Math.round(secondsRead / 60)) : 0;
  const cyclesClosedCount = cycles.filter(
    (c) => c.status === "published" && (c.period_end || "") < _todayISO
  ).length;
  const viewerRecord = {
    signedAllTime: ((attestationsQ.data as AttestationRow[]) || []).length,
    minutesReadThisCycle: minutesRead,
    checksPassed,
    retries,
    cyclesClosedCount,
    firstRun: cyclesClosedCount === 0,
  };

  let companyStanding: CompanyStanding | null = null;
  const scopeKind = identity.scope?.kind;
  if (scopeKind === "company" || scopeKind === "region") {
    const todayISO = today.toISOString().slice(0, 10);
    const activeCycles = cycles.filter(
      (c) => c.status === "published" && (c.period_end || "") >= todayISO
    );
    activeCycles.sort((a, b) =>
      (a.period_start || "").localeCompare(b.period_start || "")
    );
    const currentCycle = activeCycles[0] || null;

    const [peopleQ, excQ, acctsQ, cycleReqsQ, cycleAttQ] = await Promise.all([
      supa
        .from("people")
        .select("worker_id, display_name, is_salaried, account_key")
        .is("end_date", null)
        .in("account_key", identity.scope.accounts || []),
      supa
        .from("academy_eligibility_exceptions")
        .select("worker_id")
        .eq("eligible", false),
      supa
        .from("accounts")
        .select("team_key, region")
        .in("team_key", identity.scope.accounts || []),
      currentCycle
        ? supa
            .from("academy_requirements")
            .select("worker_id, cycle_id")
            .eq("cycle_id", currentCycle.cycle_id)
        : Promise.resolve({
            data: [] as Array<{ worker_id: string; cycle_id: string | number }>,
            error: null,
          }),
      currentCycle
        ? supa
            .from("academy_attestations")
            .select("worker_id, requirement_id")
        : Promise.resolve({
            data: [] as Array<{ worker_id: string; requirement_id: string | number | null }>,
            error: null,
          }),
    ]);
    const scopeErrorChecks: Array<[{ error: { message: string } | null }, string]> = [
      [peopleQ, "scope_people"],
      [excQ, "scope_exc"],
      [acctsQ, "scope_accounts"],
      [cycleReqsQ, "scope_cyclereqs"],
      [cycleAttQ, "scope_cycleatt"],
    ];
    for (const [q, scope] of scopeErrorChecks) {
      if (q.error) {
        console.error(`[academy/loadRoom] ${scope}:`, q.error.message);
        return { ok: false, status: 500, error: "server_error", scope };
      }
    }

    const excludedIds = new Set(
      ((excQ.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id)
    );
    const enrolledWorkerIds = new Set(
      ((cycleReqsQ.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id)
    );
    const signedWorkerIds = new Set(
      ((cycleAttQ.data as Array<{ worker_id: string }>) || []).map((r) => r.worker_id)
    );

    type PeopleScopeRow = {
      worker_id: string;
      display_name: string | null;
      is_salaried: boolean | null;
      account_key: string | null;
    };
    type AcctScopeRow = { team_key: string; region: string | null };

    const perAccount = new Map<
      string,
      {
        team_key: string;
        region: string | null;
        eligible: number;
        enrolled: number;
        people: StandingAccount["people"];
        aggregateHourly: number;
      }
    >();
    for (const a of (acctsQ.data as AcctScopeRow[]) || []) {
      perAccount.set(a.team_key, {
        team_key: a.team_key,
        region: a.region || null,
        eligible: 0,
        enrolled: 0,
        people: [],
        aggregateHourly: 0,
      });
    }
    for (const p of (peopleQ.data as PeopleScopeRow[]) || []) {
      if (!p.account_key) continue;
      const row = perAccount.get(p.account_key);
      if (!row) continue;
      if (excludedIds.has(p.worker_id)) continue;
      row.eligible += 1;
      const isEnrolled = enrolledWorkerIds.has(p.worker_id);
      const isSigned = signedWorkerIds.has(p.worker_id);
      if (isEnrolled) row.enrolled += 1;
      if (p.is_salaried || isEnrolled) {
        row.people.push({
          worker_id: p.worker_id,
          display_name: p.display_name || null,
          is_salaried: !!p.is_salaried,
          status: isSigned ? "signed" : isEnrolled ? "in_progress" : "not_enrolled",
        });
      } else {
        row.aggregateHourly += 1;
      }
    }
    for (const row of perAccount.values()) {
      row.people.sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));
    }

    const accountsOut: StandingAccount[] = [...perAccount.values()]
      .sort(
        (a, b) =>
          (a.region || "").localeCompare(b.region || "") ||
          a.team_key.localeCompare(b.team_key)
      )
      .map((r) => ({
        team_key: r.team_key,
        region: r.region,
        eligible: r.eligible,
        enrolled: r.enrolled,
        notEnrolled: r.eligible - r.enrolled,
        people: r.people,
        aggregateHourly: r.aggregateHourly,
        standing:
          r.eligible === 0
            ? "unstaffed"
            : r.enrolled === 0
              ? "not_enrolled"
              : "in_progress",
      }));

    const totals = accountsOut.reduce(
      (acc, r) => ({
        eligible: acc.eligible + r.eligible,
        enrolled: acc.enrolled + r.enrolled,
      }),
      { eligible: 0, enrolled: 0 }
    );

    companyStanding = {
      accounts: accountsOut,
      totals: {
        accounts: accountsOut.length,
        eligible: totals.eligible,
        enrolled: totals.enrolled,
        notEnrolled: totals.eligible - totals.enrolled,
      },
      currentCycle: currentCycle
        ? {
            cycle_id: currentCycle.cycle_id,
            label: currentCycle.label,
            period_start: currentCycle.period_start as string,
            period_end: currentCycle.period_end as string,
            status: currentCycle.status as string,
            audience_scope: (currentCycle.audience_scope as Record<string, unknown>) || {},
          }
        : null,
      legend: {
        in_progress: "In progress (started, no signatures exist yet)",
        not_enrolled: "Not in this cycle's audience",
        unstaffed: "No eligible people on this account",
      },
    };
  }

  let eligibleCounts: EligibleCounts = { salaried: 0, hourly: 0, total: 0 };
  try {
    eligibleCounts = await eligibleCountInScope(identity, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadRoom] eligibleCounts threw:", msg);
  }

  return {
    ok: true,
    viewer: {
      workerId: identity.workerId,
      personId: identity.personId,
      displayName: identity.displayName,
      roleTitle: identity.roleTitle,
      accountKey: identity.accountKey,
      region: identity.region,
      isSalaried: identity.isSalaried,
      isSiteLeader: identity.isSiteLeader,
      isCorp: identity.isCorp,
      scope: identity.scope,
      grants: identity.grants,
      eligibleInScope: eligibleCounts,
      record: viewerRecord,
    },
    queue,
    queueSummary,
    yearTrack,
    nextCycle,
    companyStanding,
  };
}
