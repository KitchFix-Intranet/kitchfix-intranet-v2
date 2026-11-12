// T4a (2026-11-13). The "Who sees it" sentence on the Check step +
// the record drawer's "Sent to ..." ledger line. Pulled from data,
// never hard-coded names - the render's names were written when the
// roster held different people.
//
// Reviewers = active people with pp_review.
// Copied    = active people with paf_always_cc
//             UNION  the regional director for the person's region
//             UNION  the site leaders of the person's site
//             MINUS  the sender (never CC yourself).
// Both lists exclude the sender.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "./types";
import { routeFor, type RequestRoute } from "./labels";

export interface WhoSeesIt {
  route: RequestRoute;           // "finance" | "HR"
  reviewers: string[];           // display names
  copied: string[];              // display names
}

interface PersonRow {
  worker_id: string;
  display_name: string | null;
  account_key: string | null;
  region: string | null;
  is_regional_director: boolean | null;
  is_site_leader: boolean | null;
  pp_review: boolean | null;
  paf_always_cc: boolean | null;
  status: string | null;
}

export async function buildWhoSeesIt(
  sb: SupabaseClient,
  sender: Viewer,
  personAccountKey: string | null,
  actionType: string | null,
): Promise<WhoSeesIt> {
  const route = routeFor(actionType);
  // One SELECT over ACTIVE people - we need five flag/attribute
  // columns and can derive every list from the same batch.
  const q = await sb
    .from("people")
    .select("worker_id, display_name, account_key, region, is_regional_director, is_site_leader, pp_review, paf_always_cc, status")
    .eq("status", "ACTIVE");
  const rows = (q.data ?? []) as PersonRow[];

  // Resolve the person's region via the accounts of their site key
  // (so a null-regioned people row still gets its region from
  // accounts). Build a tiny lookup from team_key -> region once.
  const acctQ = await sb.from("accounts").select("team_key, region");
  const regionByKey = new Map<string, string | null>();
  for (const a of acctQ.data ?? []) regionByKey.set(a.team_key as string, (a.region as string | null) ?? null);
  const personRegion = personAccountKey ? regionByKey.get(personAccountKey) ?? null : null;

  const senderId = sender.worker_id;
  const reviewers: string[] = [];
  const cc = new Set<string>(); // keyed by worker_id for dedup
  const cced: Array<{ id: string; name: string }> = [];

  for (const p of rows) {
    const name = (p.display_name ?? "").trim();
    if (!name) continue;
    if (p.worker_id === senderId) continue; // sender never in either list
    if (p.pp_review) reviewers.push(name);
    if (p.paf_always_cc) {
      if (!cc.has(p.worker_id)) { cc.add(p.worker_id); cced.push({ id: p.worker_id, name }); }
    }
    if (personRegion && p.is_regional_director && p.region === personRegion) {
      if (!cc.has(p.worker_id)) { cc.add(p.worker_id); cced.push({ id: p.worker_id, name }); }
    }
    if (personAccountKey && p.is_site_leader && p.account_key === personAccountKey) {
      if (!cc.has(p.worker_id)) { cc.add(p.worker_id); cced.push({ id: p.worker_id, name }); }
    }
  }

  reviewers.sort((a, b) => a.localeCompare(b));
  cced.sort((a, b) => a.name.localeCompare(b.name));
  return {
    route,
    reviewers,
    copied: cced.map((c) => c.name),
  };
}
