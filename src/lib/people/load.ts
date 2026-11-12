// My team loader. Server-only. One call does:
//   1. Pull ACTIVE people (narrow projection).
//   2. Pull accounts for the region join.
//   3. Pull pending submissions and index by person_worker_id.
//   4. Filter by scope (`inScope`).
//   5. Map each row through `toRosterPerson` (contact rule).
//   6. Pin the viewer's own card first.
//   7. Compose the site-nav entries from the already-in-scope set.
//
// The final `TeamView` is the exact shape the client island sees;
// no further data crosses the server boundary.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PeopleRow,
  AccountRow,
  Viewer,
  RosterPerson,
  SiteNavEntry,
  TeamView,
  WaitingItem,
} from "./types";
import { inScope } from "./scope";
import { toRosterPerson } from "./contact";

// Narrow projection for the roster + scope. personal_email, phone,
// start_date and birthday are DELIBERATELY absent - the roster never
// shows them, and the R-PP10 contact rule keeps them off any list
// payload. The card loader (loadPerson.ts) pulls the full projection.
const PEOPLE_SELECT =
  "worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status";

// A submissions row is "waiting" for a person when status='Pending'
// AND module != 'newhire' (R-PP21: new hires are not about a
// roster person) AND person_worker_id is set (never match on typed
// name - that is explicit in the prompt).
async function loadWaitingByPerson(sb: SupabaseClient): Promise<Map<string, WaitingItem[]>> {
  // Pending rows only. Columns are narrow; we never surface payload
  // bodies on the roster or the card.
  const q = await sb
    .from("submissions")
    .select("id, module, action_type, submitted_at, submitter_worker_id, person_worker_id, status")
    .eq("status", "Pending")
    .not("person_worker_id", "is", null)
    .neq("module", "newhire")
    .order("submitted_at", { ascending: false });
  if (q.error) throw new Error(`[people/load] waiting: ${q.error.message}`);

  // Resolve submitter display names (one extra point read per
  // unique submitter_worker_id).
  const rows = q.data ?? [];
  const submitterIds = Array.from(
    new Set(rows.map((r) => r.submitter_worker_id).filter(Boolean)),
  ) as string[];
  const submitterNames = new Map<string, string>();
  if (submitterIds.length > 0) {
    const sQ = await sb
      .from("people")
      .select("worker_id, display_name")
      .in("worker_id", submitterIds);
    if (sQ.error) throw new Error(`[people/load] submitters: ${sQ.error.message}`);
    for (const s of sQ.data ?? []) submitterNames.set(s.worker_id, s.display_name ?? "");
  }

  const byPerson = new Map<string, WaitingItem[]>();
  for (const r of rows) {
    const pid = r.person_worker_id as string;
    const list = byPerson.get(pid) ?? [];
    list.push({
      id: r.id as number,
      module: (r.module ?? "") as string,
      action_type: (r.action_type as string | null) ?? null,
      submitted_at: (r.submitted_at ?? r.submitted_at ?? "") as string,
      submitter_worker_id: (r.submitter_worker_id as string | null) ?? null,
      submitter_name: submitterNames.get((r.submitter_worker_id as string) ?? "") ?? null,
    });
    byPerson.set(pid, list);
  }
  return byPerson;
}

export async function loadTeam(
  sb: SupabaseClient,
  viewer: Viewer,
): Promise<TeamView> {
  // 1. People (ACTIVE).
  const peopleQ = await sb
    .from("people")
    .select(PEOPLE_SELECT)
    .eq("status", "ACTIVE");
  if (peopleQ.error) throw new Error(`[people/load] people: ${peopleQ.error.message}`);
  const people = (peopleQ.data as PeopleRow[]) ?? [];

  // 2. Accounts (for the region join - RD scope uses
  // accounts.region, NOT people.region on site rows).
  const acctQ = await sb
    .from("accounts")
    .select("team_key, name, city, state, region, active");
  if (acctQ.error) throw new Error(`[people/load] accounts: ${acctQ.error.message}`);
  const accounts = (acctQ.data as AccountRow[]) ?? [];
  const accountByKey = new Map(accounts.map((a) => [a.team_key, a]));
  const accountRegionByKey = new Map<string, string | null>(
    accounts.map((a) => [a.team_key, a.region ?? null]),
  );

  // 3. Waiting (Pending submissions) indexed by person_worker_id.
  const waitingByPerson = await loadWaitingByPerson(sb);

  // 4-5. Filter + map.
  const inScopeRows: RosterPerson[] = [];
  for (const p of people) {
    if (!inScope(viewer, p, accountRegionByKey)) continue;
    const region = accountRegionByKey.get(p.account_key) ?? null;
    const w = waitingByPerson.get(p.worker_id) ?? [];
    inScopeRows.push(toRosterPerson(p, region, w[0] ?? null, w.length));
  }

  // 6. Pin the viewer's own card first. If the viewer is in scope
  // of their own filter (they always are per inScope self-row
  // branch), lift their row to index 0 and sort the rest by name.
  const viewerIdx = inScopeRows.findIndex((r) => r.worker_id === viewer.worker_id);
  const self = viewerIdx >= 0 ? inScopeRows.splice(viewerIdx, 1)[0] : null;
  inScopeRows.sort((a, b) => a.display_name.localeCompare(b.display_name));
  const peopleOut = self ? [self, ...inScopeRows] : inScopeRows;

  // 7. Site nav. One entry per account_key present in the in-scope
  // set. `name` falls back to the team_key when accounts.name is
  // empty (corp rows frequently are). Totals come from the same
  // in-scope list so the count never disagrees with the roster.
  const bySite = new Map<string, { count: number; waiting: number; region: string | null }>();
  for (const r of peopleOut) {
    const cur = bySite.get(r.account_key) ?? { count: 0, waiting: 0, region: r.account_region };
    cur.count += 1;
    cur.waiting += r.waiting_count > 0 ? 1 : 0;
    bySite.set(r.account_key, cur);
  }
  const sites: SiteNavEntry[] = [...bySite.entries()]
    .map(([k, v]) => ({
      account_key: k,
      name: (accountByKey.get(k)?.name && accountByKey.get(k)!.name!.trim()) || k,
      region: v.region,
      count: v.count,
      waiting: v.waiting,
    }))
    .sort((a, b) => {
      // Corporate first (CORP region), then by region then by name.
      const ra = a.region ?? "ZZ";
      const rb = b.region ?? "ZZ";
      if (ra !== rb) return ra.localeCompare(rb);
      return a.name.localeCompare(b.name);
    });

  // Totals.
  const total_pending = peopleOut.reduce((s, r) => s + r.waiting_count, 0);

  return {
    viewer,
    sites: sites.length > 1 ? sites : [],
    people: peopleOut,
    totals: { people: peopleOut.length, pending: total_pending },
  };
}
