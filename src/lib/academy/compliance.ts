// src/lib/academy/compliance.ts
//
// Shared per-worker compliance aggregator. Both the Admin / People
// surface (E3, src/lib/academy/admin/people.ts) and the Team review
// surface (E4, src/lib/academy/team.ts) read the same facts:
//
//   outstanding   - academy_requirements row where waived_at is null
//                   and no academy_attestations row references the
//                   requirement_id.
//   signed        - academy_requirements row where an attestation row
//                   DOES reference the requirement_id.
//   waived        - academy_requirements row where waived_at is set.
//   last_signed   - MAX(signed_at) across the worker's attestations.
//   next_due      - MIN(due_date) across the worker's outstanding
//                   requirements.
//
// The rule mirrors loadRecords's `mine` branch exactly. Keeping one
// implementation here prevents the per-page surfaces from drifting
// into three slightly different definitions of "signed".
//
// Scope: this helper is READ-ONLY. It takes a set of worker_ids and
// returns a map keyed by worker_id. Callers scope the input list
// (every active person, one team, one region, etc.); the helper
// never widens.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface Counts {
  outstanding: number;
  signed: number;
  waived: number;
  last_signed_at: string | null;
  next_due_at: string | null;
}

const CHUNK = 500;
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type ReqRow = {
  requirement_id: string | number;
  worker_id: string;
  waived_at: string | null;
  due_date: string | null;
};
type AttRow = {
  requirement_id: string | number | null;
  worker_id: string;
  signed_at: string | null;
};

export async function computeComplianceForWorkers(
  supa: SupabaseClient,
  workerIds: string[],
): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!workerIds.length) return out;

  // Fan out the two scans in parallel. Each chunk pulls the fields
  // needed to apply the signed/waived/outstanding rule plus the two
  // date fields.
  const reqChunks = chunk(workerIds, CHUNK).map((c) =>
    supa
      .from("academy_requirements")
      .select("requirement_id, worker_id, waived_at, due_date")
      .in("worker_id", c) as unknown as Promise<{ data: ReqRow[] | null; error: { message: string } | null }>
  );
  const attChunks = chunk(workerIds, CHUNK).map((c) =>
    supa
      .from("academy_attestations")
      .select("requirement_id, worker_id, signed_at")
      .in("worker_id", c) as unknown as Promise<{ data: AttRow[] | null; error: { message: string } | null }>
  );
  const [reqResults, attResults] = await Promise.all([
    Promise.all(reqChunks),
    Promise.all(attChunks),
  ]);
  for (const r of reqResults) if (r.error) throw new Error(`[compliance] requirements: ${r.error.message}`);
  for (const r of attResults) if (r.error) throw new Error(`[compliance] attestations: ${r.error.message}`);

  // Pass 1: index attestations by worker. Track the per-worker
  // signed set (requirement_id strings) and the latest signed_at
  // across all attestations for that worker (including orphans
  // whose requirement_id was null - those still carry a signed_at
  // and should move last_signed_at).
  const signedReqIdsByWorker = new Map<string, Set<string>>();
  const lastSignedByWorker = new Map<string, string>();
  for (const r of attResults) {
    for (const row of r.data || []) {
      if (!signedReqIdsByWorker.has(row.worker_id)) {
        signedReqIdsByWorker.set(row.worker_id, new Set<string>());
      }
      if (row.requirement_id != null) {
        signedReqIdsByWorker.get(row.worker_id)!.add(String(row.requirement_id));
      }
      if (row.signed_at) {
        const prev = lastSignedByWorker.get(row.worker_id);
        if (!prev || row.signed_at > prev) lastSignedByWorker.set(row.worker_id, row.signed_at);
      }
    }
  }

  // Pass 2: bucket each requirement into waived | signed | outstanding
  // and compute per-worker outstanding next_due.
  for (const r of reqResults) {
    for (const row of r.data || []) {
      const bucket = out.get(row.worker_id) ?? {
        outstanding: 0,
        signed: 0,
        waived: 0,
        last_signed_at: null,
        next_due_at: null,
      };
      const signedSet = signedReqIdsByWorker.get(row.worker_id);
      if (row.waived_at != null) {
        bucket.waived += 1;
      } else if (signedSet && signedSet.has(String(row.requirement_id))) {
        bucket.signed += 1;
      } else {
        bucket.outstanding += 1;
        if (row.due_date) {
          if (!bucket.next_due_at || row.due_date < bucket.next_due_at) {
            bucket.next_due_at = row.due_date;
          }
        }
      }
      out.set(row.worker_id, bucket);
    }
  }

  // Attach last_signed_at (independent of the requirements-row set).
  // A worker with attestations but no requirements still gets a
  // last_signed_at here; counts stay at zero which is correct.
  for (const [workerId, signedAt] of lastSignedByWorker) {
    const bucket = out.get(workerId) ?? {
      outstanding: 0,
      signed: 0,
      waived: 0,
      last_signed_at: null,
      next_due_at: null,
    };
    bucket.last_signed_at = signedAt;
    out.set(workerId, bucket);
  }

  return out;
}
