// src/lib/academy/admin/people.ts
//
// Admin / People loader. Builds the owner-facing roster for
// /academy/admin/people:
//
//   - Active humans de-duped by person_id (seasonal rehires hold
//     multiple worker_id rows under one person_id; we never render
//     one row per stint).
//   - Each human's training compliance: outstanding / signed /
//     waived counts, last signed date, next due date on their
//     outstanding list. Uses the same filter rule loadRecords
//     applies to one worker (requirement is signed when an
//     academy_attestations row references the requirement_id;
//     waived when waived_at is non-null; else outstanding).
//   - Current region leads (academy_region_leads) + the canonical
//     region list (distinct accounts.region, non-null) so the
//     assign-lead client can pick from a bounded set.
//
// Not touched: academy_grants, academy_eligibility_exceptions.
// Both are managed in Studio for E3; a dedicated editor arrives in
// a later train. The eligibility exception WOULD subtract outstanding
// counts, but it does not change the SIGNATURE / WAIVED facts shown
// here, so the compliance read is still correct for the "has this
// person done their trainings" question - just a few outstanding
// rows may be shown that the engine would skip at publish time.
// Noted in the UI copy.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { computeComplianceForWorkers } from "@/lib/academy/compliance";

export interface PersonRow {
  // Identity.
  person_id: string | null; // null when a stint row is missing
  worker_id: string;
  work_email: string | null;
  display_name: string | null;
  title: string | null;
  // Placement.
  account_key: string | null;
  region: string | null;
  // Class.
  is_salaried: boolean;
  worker_class: "salaried" | "hourly";
  is_site_leader: boolean;
  is_corp: boolean;
  status: string | null;
  // Compliance (reuses loadRecords' rule applied to the batch rows).
  outstanding: number;
  signed: number;
  waived: number;
  last_signed_at: string | null;
  next_due_at: string | null; // earliest outstanding due_date; may be null
}

export interface RegionLead {
  region: string;
  email: string;
  assigned_by: string | null;
  assigned_at: string | null;
  display_name: string | null; // joined from people.display_name on work_email
}

export interface AdminPeopleView {
  roster: PersonRow[];
  rosterDedupProof: {
    activePeopleCount: number;
    distinctPersonIdsInRoster: number;
    workersWithoutStint: number;
    rows: number; // == roster.length
  };
  regions: string[]; // canonical, from accounts.region (distinct, non-null, sorted)
  leads: RegionLead[];
}

// Chunk helper for IN clauses - PostgREST caps at ~1,000 rows but the
// request-side IN list limit is lower on URL length; 500 is safe.
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const CHUNK = 500;

export async function loadAdminPeople(supaIn?: SupabaseClient): Promise<AdminPeopleView> {
  const supa = supaIn ?? serviceClient();

  // Step 1. Active roster from `people`. status='ACTIVE' is load-
  // bearing - identity.ts holds the full rationale. Null end_date is
  // the complementary signal for a currently employed person.
  const peopleQ = await supa
    .from("people")
    .select(
      "worker_id, work_email, display_name, title, account_key, is_salaried, is_corp, is_site_leader, status, region"
    )
    .eq("status", "ACTIVE")
    .order("display_name", { ascending: true });
  if (peopleQ.error) {
    throw new Error(`[admin/people] people: ${peopleQ.error.message}`);
  }
  type PeopleRaw = {
    worker_id: string;
    work_email: string | null;
    display_name: string | null;
    title: string | null;
    account_key: string | null;
    is_salaried: boolean | null;
    is_corp: boolean | null;
    is_site_leader: boolean | null;
    status: string | null;
    region: string | null;
  };
  const peopleRows = (peopleQ.data as PeopleRaw[]) || [];
  const workerIds = peopleRows.map((p) => p.worker_id);
  const accountKeys = [
    ...new Set(peopleRows.map((p) => p.account_key).filter((x): x is string => Boolean(x))),
  ];

  // Step 2. Fan out the per-worker lookups + the account region map
  // + the region-leads list in parallel. academy_person_stints maps
  // worker_id -> person_id for dedup; compliance (requirements +
  // attestations) comes from the shared helper so E3 and E4 agree
  // on the signed/waived/outstanding rule.
  const stintChunks: Array<Promise<{ data: Array<{ worker_id: string; person_id: string | null }> | null; error: { message: string } | null }>> =
    chunk(workerIds, CHUNK).map((c) =>
      supa.from("academy_person_stints").select("worker_id, person_id").in("worker_id", c) as unknown as Promise<{ data: Array<{ worker_id: string; person_id: string | null }> | null; error: { message: string } | null }>
    );
  const [
    stintResults,
    counts,
    accountsQ,
    regionsQ,
    leadsQ,
  ] = await Promise.all([
    Promise.all(stintChunks),
    computeComplianceForWorkers(supa, workerIds),
    accountKeys.length > 0
      ? supa.from("accounts").select("team_key, region").in("team_key", accountKeys)
      : Promise.resolve({ data: [] as Array<{ team_key: string; region: string | null }>, error: null }),
    // Canonical region list - every active account's distinct region.
    supa.from("accounts").select("region").neq("active", false),
    supa
      .from("academy_region_leads")
      .select("region, email, assigned_by, assigned_at")
      .order("region", { ascending: true }),
  ]);
  for (const r of stintResults) if (r.error) throw new Error(`[admin/people] stints: ${r.error.message}`);
  if (accountsQ.error) throw new Error(`[admin/people] accounts: ${accountsQ.error.message}`);
  if (regionsQ.error) throw new Error(`[admin/people] regions: ${regionsQ.error.message}`);
  if (leadsQ.error) throw new Error(`[admin/people] leads: ${leadsQ.error.message}`);

  // Index the fan-out responses.
  const personIdByWorker = new Map<string, string | null>();
  for (const r of stintResults) {
    for (const row of r.data || []) {
      personIdByWorker.set(row.worker_id, row.person_id ?? null);
    }
  }

  const regionByAccount = new Map<string, string | null>();
  for (const a of (accountsQ.data as Array<{ team_key: string; region: string | null }>) || []) {
    regionByAccount.set(a.team_key, a.region);
  }

  // Canonical regions - distinct, non-null, sorted.
  const regionSet = new Set<string>();
  for (const r of (regionsQ.data as Array<{ region: string | null }>) || []) {
    if (r.region) regionSet.add(r.region);
  }
  const regions = [...regionSet].sort();

  // Build the roster. De-dup by person_id so rehires with multiple
  // worker_ids collapse into one row; a worker with no stint row
  // stays as its own entry (person_id is null, which cannot collide).
  const seenPersonIds = new Set<string>();
  const rawRows: PersonRow[] = peopleRows.map((p) => {
    const personId = personIdByWorker.get(p.worker_id) ?? null;
    const c = counts.get(p.worker_id) ?? {
      outstanding: 0,
      signed: 0,
      waived: 0,
      last_signed_at: null,
      next_due_at: null,
    };
    return {
      person_id: personId,
      worker_id: p.worker_id,
      work_email: p.work_email,
      display_name: p.display_name,
      title: p.title,
      account_key: p.account_key,
      region: (p.account_key ? regionByAccount.get(p.account_key) ?? null : null) || p.region,
      is_salaried: !!p.is_salaried,
      worker_class: p.is_salaried ? "salaried" : "hourly",
      is_site_leader: !!p.is_site_leader,
      is_corp: !!p.is_corp,
      status: p.status,
      outstanding: c.outstanding,
      signed: c.signed,
      waived: c.waived,
      last_signed_at: c.last_signed_at,
      next_due_at: c.next_due_at,
    };
  });
  const roster: PersonRow[] = [];
  for (const row of rawRows) {
    if (row.person_id) {
      if (seenPersonIds.has(row.person_id)) continue;
      seenPersonIds.add(row.person_id);
    }
    roster.push(row);
  }

  const workersWithoutStint = rawRows.filter((r) => !r.person_id).length;

  // Region leads - join each to its person's display_name so the
  // owner sees who the email belongs to in the UI.
  const leadRows = (leadsQ.data as Array<{ region: string; email: string; assigned_by: string | null; assigned_at: string | null }>) || [];
  const leadEmails = [...new Set(leadRows.map((l) => (l.email || "").toLowerCase()).filter(Boolean))];
  const nameByEmail = new Map<string, string>();
  if (leadEmails.length > 0) {
    // Avoid a huge chained .or; one quick fetch keyed on ilike for
    // each unique email is fine for the handful of leads today.
    const leadPeopleQ = await supa
      .from("people")
      .select("work_email, display_name")
      .in("work_email", leadEmails);
    if (leadPeopleQ.error) {
      throw new Error(`[admin/people] lead people: ${leadPeopleQ.error.message}`);
    }
    for (const r of (leadPeopleQ.data as Array<{ work_email: string | null; display_name: string | null }>) || []) {
      if (r.work_email) nameByEmail.set(r.work_email.toLowerCase(), r.display_name || "");
    }
  }
  const leads: RegionLead[] = leadRows.map((l) => ({
    region: l.region,
    email: l.email,
    assigned_by: l.assigned_by,
    assigned_at: l.assigned_at,
    display_name: nameByEmail.get((l.email || "").toLowerCase()) || null,
  }));

  return {
    roster,
    rosterDedupProof: {
      activePeopleCount: peopleRows.length,
      distinctPersonIdsInRoster: seenPersonIds.size,
      workersWithoutStint,
      rows: roster.length,
    },
    regions,
    leads,
  };
}
