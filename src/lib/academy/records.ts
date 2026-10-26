// src/lib/academy/records.ts
//
// Loader for /api/academy/records. Records is the ledger surface:
// every row is a FACT with a source. Nothing on this wire is a
// computed status. If a number here disagrees with the Academy room,
// Records is right.
//
// Shape:
//   mine: { signatures, waived, outstanding }
//   company: present only when viewer holds academy_admin.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import type { AcademyIdentity } from "./identity";

export type RecordsResult =
  | {
      ok: false;
      status: 404 | 500;
      error: string;
      scope?: string;
      detail?: string;
    }
  | ({ ok: true } & RecordsBody);

export interface RecordsBody {
  viewer: {
    workerId: string;
    displayName: string | null;
    grants: AcademyIdentity["grants"];
    isAcademyAdmin: boolean;
  };
  mine: {
    signatures: SignatureRow[];
    waived: WaivedRow[];
    outstanding: OutstandingRow[];
  };
  company: CompanyRecords | null;
}

export interface DocLabel {
  id: string;
  title: string;
  doc_class: string | null;
}

export interface ModuleLabel {
  key: string;
  source_section: string | null;
  description: string | null;
}

export interface SignatureRow {
  attestation_id: string | number;
  doc: DocLabel;
  module: ModuleLabel;
  doc_version: string | number | null;
  signed_at: string | null;
  certificate_serial: string | null;
  attempts_count: number | null;
  attempts_passed: number | null;
  attempts_total: number | null;
  minutes: number;
  certificate_href: string;
}

export interface WaivedRow {
  requirement_id: string | number;
  doc: DocLabel;
  module: ModuleLabel;
  doc_version: string | number | null;
  cycle_id: string | number | null;
  cycle_label: string | null;
  waived_at: string | null;
  waived_by: string | null;
  waive_reason: string | null;
}

export interface OutstandingRow {
  requirement_id: string | number;
  doc: DocLabel;
  module: ModuleLabel;
  doc_version: string | number | null;
  cycle_id: string | number | null;
  cycle_label: string | null;
  due_date: string | null;
  issued_at: string | null;
  source: string | null;
  est_minutes: number;
}

export interface CompanyRecords {
  signatures: Array<{
    attestation_id: string | number;
    worker_id: string;
    person: {
      display_name: string | null;
      account_key: string | null;
      account_region: string | null;
      is_salaried: boolean;
    };
    doc: DocLabel;
    module: ModuleLabel;
    doc_version: string | number | null;
    signed_at: string | null;
    certificate_serial: string | null;
    cycle_id: string | number | null;
    cycle_label: string | null;
    certificate_href: string;
  }>;
  accounts: Array<{ team_key: string; region: string | null }>;
  cycles: Array<{ cycle_id: string | number; label: string; period_start: string | null }>;
  currentCycle: { cycle_id: string | number; label: string } | null;
  enrolledInCurrent: number;
  truncated: boolean;
}

export async function loadRecords(
  email: string,
  supaIn?: SupabaseClient
): Promise<RecordsResult> {
  const supa = supaIn || serviceClient();

  let identity: AcademyIdentity | null;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadRecords] resolve threw:", msg);
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

  const [reqsQ, attestationsQ, attemptsQ, progressQ, cyclesQ] = await Promise.all([
    supa
      .from("academy_requirements")
      .select(
        "requirement_id, worker_id, doc_id, obligation_key, doc_version, est_minutes, cycle_id, due_date, issued_at, waived_at, waived_by, waive_reason, source"
      )
      .eq("worker_id", identity.workerId)
      .order("due_date", { ascending: true }),
    supa
      .from("academy_attestations")
      .select(
        "attestation_id, requirement_id, doc_id, obligation_key, doc_version, signed_at, certificate_serial, attempts_count, time_spent_seconds"
      )
      .eq("worker_id", identity.workerId)
      .order("signed_at", { ascending: false }),
    supa
      .from("academy_check_attempts")
      .select("attempt_id, requirement_id, correct")
      .eq("worker_id", identity.workerId),
    supa
      .from("academy_module_progress")
      .select("requirement_id, time_spent_seconds")
      .eq("worker_id", identity.workerId),
    supa
      .from("academy_cycles")
      .select("cycle_id, label, period_start, period_end, status")
      .order("period_start", { ascending: true }),
  ]);
  const topErrorChecks: Array<[{ error: { message: string } | null }, string]> = [
    [reqsQ, "requirements"],
    [attestationsQ, "attestations"],
    [attemptsQ, "attempts"],
    [progressQ, "progress"],
    [cyclesQ, "cycles"],
  ];
  for (const [q, scope] of topErrorChecks) {
    if (q.error) {
      console.error(`[academy/loadRecords] ${scope}:`, q.error.message);
      return { ok: false, status: 500, error: "server_error", scope };
    }
  }

  type ReqRow = {
    requirement_id: string | number;
    worker_id: string;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    est_minutes: number | null;
    cycle_id: string | number | null;
    due_date: string | null;
    issued_at: string | null;
    waived_at: string | null;
    waived_by: string | null;
    waive_reason: string | null;
    source: string | null;
  };
  type AttRow = {
    attestation_id: string | number;
    requirement_id: string | number | null;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    signed_at: string | null;
    certificate_serial: string | null;
    attempts_count: number | null;
    time_spent_seconds: number | null;
  };
  type CycleRow = {
    cycle_id: string | number;
    label: string;
    period_start: string | null;
    period_end: string | null;
    status: string | null;
  };
  const reqs = (reqsQ.data as ReqRow[]) || [];
  const attestations = (attestationsQ.data as AttRow[]) || [];
  const attempts =
    (attemptsQ.data as Array<{
      attempt_id: string | number;
      requirement_id: string | number | null;
      correct: boolean | null;
    }>) || [];
  const progress =
    (progressQ.data as Array<{
      requirement_id: string | number | null;
      time_spent_seconds: number | null;
    }>) || [];
  const cycles = (cyclesQ.data as CycleRow[]) || [];

  const distinctDocIds = [
    ...new Set(
      [...reqs.map((r) => r.doc_id), ...attestations.map((a) => a.doc_id)].filter(Boolean)
    ),
  ];
  const [docsQ, obligationsQ] = await Promise.all([
    distinctDocIds.length > 0
      ? supa
          .from("documents")
          .select("id, title, doc_class, version")
          .in("id", distinctDocIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    distinctDocIds.length > 0
      ? supa
          .from("academy_obligations")
          .select("doc_id, obligation_key, source_section, description")
          .in("doc_id", distinctDocIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ]);
  if (docsQ.error) {
    console.error("[academy/loadRecords] documents:", docsQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "documents" };
  }
  if (obligationsQ.error) {
    console.error("[academy/loadRecords] obligations:", obligationsQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "obligations" };
  }

  type DocRow = {
    id: string;
    title: string | null;
    doc_class: string | null;
    version: string | number | null;
  };
  type ObRow = {
    doc_id: string;
    obligation_key: string;
    source_section: string | null;
    description: string | null;
  };

  const docsById = new Map<string, DocRow>();
  for (const d of (docsQ.data as DocRow[]) || []) docsById.set(d.id, d);
  const obligationsByKey = new Map<string, ObRow>();
  for (const ob of (obligationsQ.data as ObRow[]) || []) {
    obligationsByKey.set(`${ob.doc_id}|${ob.obligation_key}`, ob);
  }
  const cyclesById = new Map<string | number, CycleRow>();
  for (const c of cycles) cyclesById.set(c.cycle_id, c);
  const attestationsByReq = new Map<string | number, AttRow>();
  for (const a of attestations) {
    if (a.requirement_id != null) attestationsByReq.set(a.requirement_id, a);
  }

  const attemptStatsByReq = new Map<string | number, { total: number; correct: number }>();
  for (const at of attempts) {
    if (at.requirement_id == null) continue;
    const s = attemptStatsByReq.get(at.requirement_id) || { total: 0, correct: 0 };
    s.total += 1;
    if (at.correct) s.correct += 1;
    attemptStatsByReq.set(at.requirement_id, s);
  }
  const progressByReq = new Map<string | number, number>();
  for (const p of progress) {
    if (p.requirement_id == null) continue;
    progressByReq.set(p.requirement_id, p.time_spent_seconds || 0);
  }

  function docLabel(docId: string): DocLabel {
    const d = docsById.get(docId);
    return {
      id: docId,
      title: d?.title || docId,
      doc_class: d?.doc_class || null,
    };
  }
  function moduleLabel(docId: string, obligationKey: string): ModuleLabel {
    const ob = obligationsByKey.get(`${docId}|${obligationKey}`);
    return {
      key: obligationKey,
      source_section: ob?.source_section || null,
      description: ob?.description || null,
    };
  }

  const signatures: SignatureRow[] = attestations.map((a) => {
    const stats = a.requirement_id != null ? attemptStatsByReq.get(a.requirement_id) || null : null;
    const progressSeconds = a.requirement_id != null
      ? progressByReq.get(a.requirement_id) || 0
      : 0;
    const seconds =
      a.time_spent_seconds != null && a.time_spent_seconds >= 0
        ? a.time_spent_seconds
        : progressSeconds;
    const minutes = seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
    return {
      attestation_id: a.attestation_id,
      doc: docLabel(a.doc_id),
      module: moduleLabel(a.doc_id, a.obligation_key),
      doc_version: a.doc_version,
      signed_at: a.signed_at,
      certificate_serial: a.certificate_serial,
      attempts_count: a.attempts_count,
      attempts_passed: stats?.correct ?? null,
      attempts_total: stats?.total ?? null,
      minutes,
      certificate_href: `/api/academy/certificate/${a.attestation_id}`,
    };
  });

  const waived: WaivedRow[] = reqs
    .filter((r) => r.waived_at != null)
    .map((r) => ({
      requirement_id: r.requirement_id,
      doc: docLabel(r.doc_id),
      module: moduleLabel(r.doc_id, r.obligation_key),
      doc_version: r.doc_version,
      cycle_id: r.cycle_id,
      cycle_label: r.cycle_id != null ? cyclesById.get(r.cycle_id)?.label || null : null,
      waived_at: r.waived_at,
      waived_by: r.waived_by,
      waive_reason: r.waive_reason,
    }))
    .sort((a, b) => (b.waived_at || "").localeCompare(a.waived_at || ""));

  const outstanding: OutstandingRow[] = reqs
    .filter((r) => r.waived_at == null && !attestationsByReq.has(r.requirement_id))
    .map((r) => ({
      requirement_id: r.requirement_id,
      doc: docLabel(r.doc_id),
      module: moduleLabel(r.doc_id, r.obligation_key),
      doc_version: r.doc_version,
      cycle_id: r.cycle_id,
      cycle_label: r.cycle_id != null ? cyclesById.get(r.cycle_id)?.label || null : null,
      due_date: r.due_date,
      issued_at: r.issued_at,
      source: r.source,
      est_minutes: r.est_minutes || 0,
    }))
    .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));

  const mine = { signatures, waived, outstanding };

  // ── Company ────────────────────────────────────────────────
  let company: CompanyRecords | null = null;
  if ((identity.grants || []).includes("academy_admin")) {
    const [allAttQ, peopleQ, accountsQ] = await Promise.all([
      supa
        .from("academy_attestations")
        .select(
          "attestation_id, worker_id, requirement_id, doc_id, obligation_key, doc_version, signed_at, certificate_serial"
        )
        .order("signed_at", { ascending: false })
        .limit(2000),
      supa.from("people").select("worker_id, display_name, account_key, is_salaried"),
      supa.from("accounts").select("team_key, region, active"),
    ]);
    const companyErrorChecks: Array<[{ error: { message: string } | null }, string]> = [
      [allAttQ, "company_attestations"],
      [peopleQ, "company_people"],
      [accountsQ, "company_accounts"],
    ];
    for (const [q, scope] of companyErrorChecks) {
      if (q.error) {
        console.error(`[academy/loadRecords] ${scope}:`, q.error.message);
        return { ok: false, status: 500, error: "server_error", scope };
      }
    }

    type AllAttRow = {
      attestation_id: string | number;
      worker_id: string;
      requirement_id: string | number | null;
      doc_id: string;
      obligation_key: string;
      doc_version: string | number | null;
      signed_at: string | null;
      certificate_serial: string | null;
    };
    type PeopleRow = {
      worker_id: string;
      display_name: string | null;
      account_key: string | null;
      is_salaried: boolean | null;
    };
    type AcctRow = {
      team_key: string;
      region: string | null;
      active: boolean | null;
    };

    const allAtts = (allAttQ.data as AllAttRow[]) || [];
    const peopleByWorker = new Map<string, PeopleRow>();
    for (const p of (peopleQ.data as PeopleRow[]) || []) peopleByWorker.set(p.worker_id, p);
    const accountsByKey = new Map<string, AcctRow>();
    for (const a of (accountsQ.data as AcctRow[]) || []) accountsByKey.set(a.team_key, a);

    const companyDocIds = [...new Set(allAtts.map((a) => a.doc_id).filter(Boolean))];
    const missingDocIds = companyDocIds.filter((id) => !docsById.has(id));
    if (missingDocIds.length > 0) {
      const extraDocsQ = await supa
        .from("documents")
        .select("id, title, doc_class, version")
        .in("id", missingDocIds);
      if (extraDocsQ.error) {
        console.error("[academy/loadRecords] company documents:", extraDocsQ.error.message);
        return { ok: false, status: 500, error: "server_error", scope: "company_documents" };
      }
      for (const d of (extraDocsQ.data as DocRow[]) || []) docsById.set(d.id, d);
    }
    const companyMissingObPairs = [
      ...new Set(
        allAtts
          .map((a) => `${a.doc_id}|${a.obligation_key}`)
          .filter((k) => !obligationsByKey.has(k))
      ),
    ];
    if (companyMissingObPairs.length > 0) {
      const extraObDocIds = [...new Set(companyMissingObPairs.map((p) => p.split("|")[0]))];
      const extraObQ = await supa
        .from("academy_obligations")
        .select("doc_id, obligation_key, source_section, description")
        .in("doc_id", extraObDocIds);
      if (extraObQ.error) {
        console.error("[academy/loadRecords] company obligations:", extraObQ.error.message);
        return { ok: false, status: 500, error: "server_error", scope: "company_obligations" };
      }
      for (const ob of (extraObQ.data as ObRow[]) || []) {
        obligationsByKey.set(`${ob.doc_id}|${ob.obligation_key}`, ob);
      }
    }

    const companyReqIds = [...new Set(allAtts.map((a) => a.requirement_id).filter(Boolean))] as Array<
      string | number
    >;
    const reqCycleByReqId = new Map<string | number, string | number | null>();
    if (companyReqIds.length > 0) {
      const reqCycleQ = await supa
        .from("academy_requirements")
        .select("requirement_id, cycle_id")
        .in("requirement_id", companyReqIds);
      if (reqCycleQ.error) {
        console.error("[academy/loadRecords] company req cycles:", reqCycleQ.error.message);
        return { ok: false, status: 500, error: "server_error", scope: "company_req_cycles" };
      }
      for (const r of (reqCycleQ.data as Array<{
        requirement_id: string | number;
        cycle_id: string | number | null;
      }>) || []) {
        reqCycleByReqId.set(r.requirement_id, r.cycle_id);
      }
    }

    const companySignatures: CompanyRecords["signatures"] = allAtts.map((a) => {
      const person = peopleByWorker.get(a.worker_id) || null;
      const cycleId = a.requirement_id != null ? reqCycleByReqId.get(a.requirement_id) : null;
      const cyc = cycleId != null ? cyclesById.get(cycleId) : null;
      const acct = person?.account_key ? accountsByKey.get(person.account_key) : null;
      return {
        attestation_id: a.attestation_id,
        worker_id: a.worker_id,
        person: {
          display_name: person?.display_name || null,
          account_key: person?.account_key || null,
          account_region: acct?.region || null,
          is_salaried: !!person?.is_salaried,
        },
        doc: docLabel(a.doc_id),
        module: moduleLabel(a.doc_id, a.obligation_key),
        doc_version: a.doc_version,
        signed_at: a.signed_at,
        certificate_serial: a.certificate_serial,
        cycle_id: cycleId || null,
        cycle_label: cyc?.label || null,
        certificate_href: `/api/academy/certificate/${a.attestation_id}`,
      };
    });

    const accountFacetKeys = new Set<string>(
      companySignatures.map((s) => s.person.account_key).filter((x): x is string => Boolean(x))
    );
    for (const k of identity.scope?.accounts || []) accountFacetKeys.add(k);
    const accountFacets = [...accountFacetKeys]
      .map((key) => {
        const a = accountsByKey.get(key);
        return {
          team_key: key,
          region: a?.region || null,
        };
      })
      .sort(
        (a, b) =>
          (a.region || "").localeCompare(b.region || "") ||
          a.team_key.localeCompare(b.team_key)
      );
    const cycleFacets = cycles
      .filter((c) => c.status === "published")
      .map((c) => ({
        cycle_id: c.cycle_id,
        label: c.label,
        period_start: c.period_start,
      }))
      .sort((a, b) => (b.period_start || "").localeCompare(a.period_start || ""));

    const todayISO = new Date().toISOString().slice(0, 10);
    const activeCycles = cycles
      .filter((c) => c.status === "published" && (c.period_end || "") >= todayISO)
      .sort((a, b) => (a.period_start || "").localeCompare(b.period_start || ""));
    const currentCycle = activeCycles[0] || null;
    let enrolledInCurrent = 0;
    if (currentCycle) {
      const enrollQ = await supa
        .from("academy_requirements")
        .select("worker_id", { count: "exact", head: true })
        .eq("cycle_id", currentCycle.cycle_id);
      if (!enrollQ.error) {
        enrolledInCurrent = enrollQ.count || 0;
      }
    }

    company = {
      signatures: companySignatures,
      accounts: accountFacets,
      cycles: cycleFacets,
      currentCycle: currentCycle
        ? { cycle_id: currentCycle.cycle_id, label: currentCycle.label }
        : null,
      enrolledInCurrent,
      truncated: companySignatures.length >= 2000,
    };
  }

  return {
    ok: true,
    viewer: {
      workerId: identity.workerId,
      displayName: identity.displayName,
      grants: identity.grants || [],
      isAcademyAdmin: (identity.grants || []).includes("academy_admin"),
    },
    mine,
    company,
  };
}
