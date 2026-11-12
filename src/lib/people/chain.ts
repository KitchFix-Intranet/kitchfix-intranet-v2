// Shared "does `candidate` sit above `person` in the reports chain"
// check. Walks `people.manager_worker_id` from `startManagerId`
// upward until it either hits `candidateWorkerId` (-> true) or runs
// out of ancestors. Cycle-safe via a seen-set; self-manager
// (worker_id === manager_worker_id) and A->B->A bad rows cannot send
// the loop anywhere.
//
// Used by:
//   - loadPerson.ts R-PP54 History visibility (does viewer sit above
//     the person being viewed)
//   - loadRecord.ts R-PP21 "may open" check (does viewer sit above
//     the PERSON the record is about, not the sender)

import type { SupabaseClient } from "@supabase/supabase-js";

export async function viewerIsInChain(
  sb: SupabaseClient,
  candidateWorkerId: string,
  startManagerId: string | null,
): Promise<boolean> {
  if (!startManagerId) return false;
  const seen = new Set<string>();
  let cursor: string | null = startManagerId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === candidateWorkerId) return true;
    seen.add(cursor);
    const q: { data: { manager_worker_id: string | null } | null; error: unknown } = await sb
      .from("people")
      .select("manager_worker_id")
      .eq("worker_id", cursor)
      .maybeSingle();
    if (q.error || !q.data) return false;
    cursor = q.data.manager_worker_id ?? null;
  }
  return false;
}
