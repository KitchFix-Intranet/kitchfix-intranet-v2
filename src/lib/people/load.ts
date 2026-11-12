// My team loader. Server-only. One call does:
//   1. Pull ACTIVE people (narrow projection).
//   2. Pull accounts for the region join.
//   3. Pull pending submissions and index by person_worker_id.
//   4. Filter by scope (`inScope`).
//   5. Map each row through `toRosterPerson` (contact rule).
//   6. Build per-site panels in the render's shape: viewer removed
//      (pinned on the "You" card above), sorted site-leader ->
//      salaried -> hourly, divider index on the first hourly.
//   7. Compose the site-nav entries from the already-in-scope set.
//   8. Pick the default panel: first site with pending > 0, else the
//      viewer's own site, else the first site.
//
// The final `TeamView` is the exact shape the client island sees;
// no further data crosses the server boundary.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PeopleRow,
  AccountRow,
  Viewer,
  RosterPerson,
  SelfRosterPerson,
  SiteNavEntry,
  SitePanel,
  TeamView,
  WaitingItem,
} from "./types";
import { inScope } from "./scope";
import { toRosterPerson, toSelfRosterPerson } from "./contact";
import { isLate } from "./thresholds";
import { labelForAction } from "./labels";

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
  const q = await sb
    .from("submissions")
    .select("id, module, action_type, submitted_at, submitter_worker_id, person_worker_id, status")
    .eq("status", "Pending")
    .not("person_worker_id", "is", null)
    .neq("module", "newhire")
    .order("submitted_at", { ascending: false });
  if (q.error) throw new Error(`[people/load] waiting: ${q.error.message}`);

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
      id: (r.id ?? "") as string,
      module: (r.module ?? "") as string,
      action_type: (r.action_type as string | null) ?? null,
      submitted_at: (r.submitted_at ?? "") as string,
      submitter_worker_id: (r.submitter_worker_id as string | null) ?? null,
      submitter_name: submitterNames.get((r.submitter_worker_id as string) ?? "") ?? null,
      label: labelForAction(r.module as string | null, r.action_type as string | null),
    });
    byPerson.set(pid, list);
  }
  return byPerson;
}

// T2.2 (2026-11-12). 3-letter team mark used on the left nav and the
// panel head. Takes the account_key's prefix before " - " (e.g.
// "STL - FL" -> "STL", "TXR - TX - H" -> "TXR"). CORP maps to "KF"
// per the render (KitchFix Team).
function markFor(account_key: string): string {
  if (account_key === "CORP") return "KF";
  const head = account_key.split(/\s*-\s*/, 1)[0] ?? account_key;
  return head.slice(0, 3).toUpperCase();
}

// T2.2 (2026-11-12). Level label on the panel head. accounts.level
// when present; the site_manager override to "hourly team" applied
// here when the viewer only sees the hourly population of this site.
// T2.3 (2026-11-13): the CORP account carries level "CORP" in the
// DB; render it as "Corporate" so the site head reads
// "Chicago, IL · Corporate · 10 people" instead of leaking the code.
function levelFor(
  team_key: string,
  acct: AccountRow | undefined,
  overrideHourlyTeam: boolean,
): string | null {
  if (overrideHourlyTeam) return "hourly team";
  if (team_key === "CORP") return "Corporate";
  const s = (acct?.level ?? "").trim();
  return s || null;
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

  // 2. Accounts (for the region join + name / city / state / level).
  const acctQ = await sb
    .from("accounts")
    .select("team_key, name, city, state, region, active, level");
  if (acctQ.error) throw new Error(`[people/load] accounts: ${acctQ.error.message}`);
  const accounts = (acctQ.data as AccountRow[]) ?? [];
  const accountByKey = new Map(accounts.map((a) => [a.team_key, a]));
  const accountRegionByKey = new Map<string, string | null>(
    accounts.map((a) => [a.team_key, a.region ?? null]),
  );

  // 3. Waiting (Pending submissions) indexed by person_worker_id.
  const waitingByPerson = await loadWaitingByPerson(sb);

  // 4-5. Filter + map. toRosterPerson carries no request fields at
  // all - only `waiting_count` - so no non-self row can leak id,
  // module, action_type, submitted_at, submitter_* or label. The
  // viewer's own row is built separately below via toSelfRosterPerson.
  const inScopeRows: RosterPerson[] = [];
  let viewerPeopleRow: PeopleRow | null = null;
  for (const p of people) {
    if (!inScope(viewer, p, accountRegionByKey)) continue;
    const region = accountRegionByKey.get(p.account_key) ?? null;
    const w = waitingByPerson.get(p.worker_id) ?? [];
    inScopeRows.push(toRosterPerson(p, region, w.length));
    if (p.worker_id === viewer.worker_id) viewerPeopleRow = p;
  }

  // The "You" card. Uses toSelfRosterPerson so the viewer sees the
  // full WaitingItem (with label) on their OWN row - the one place
  // the render shows the label in the roster.
  let selfRow: SelfRosterPerson | null = null;
  if (viewerPeopleRow) {
    const region = accountRegionByKey.get(viewerPeopleRow.account_key) ?? null;
    const w = waitingByPerson.get(viewerPeopleRow.worker_id) ?? [];
    selfRow = toSelfRosterPerson(viewerPeopleRow, region, w[0] ?? null, w.length);
  }

  // Keep a flat sorted list (used by search-across-all + the flat
  // People total). Pin self first.
  const sortedFlat = [...inScopeRows].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const selfInFlat = inScopeRows.find((r) => r.worker_id === viewer.worker_id) ?? null;
  const flatOut = selfInFlat
    ? [selfInFlat, ...sortedFlat.filter((r) => r.worker_id !== viewer.worker_id)]
    : sortedFlat;

  // T2.2 site leaders map (first-alphabetical per account among
  // people in scope; may be null for CORP).
  const siteLeaders = new Map<string, string>();
  for (const p of people) {
    if (!p.is_site_leader) continue;
    const prev = siteLeaders.get(p.account_key);
    const name = (p.display_name ?? "").trim();
    if (!prev || name.localeCompare(prev) < 0) siteLeaders.set(p.account_key, name);
  }

  // T2.2 per-site grouping. The viewer's own row is REMOVED from
  // every panel (it lives on the "You" card). The `count` on the
  // nav entry + panel head reports the full in-scope count (viewer
  // included), matching the render.
  const bySite = new Map<string, RosterPerson[]>();
  for (const r of inScopeRows) {
    const list = bySite.get(r.account_key) ?? [];
    list.push(r);
    bySite.set(r.account_key, list);
  }
  const panels: Record<string, SitePanel> = {};
  const sites: SiteNavEntry[] = [];
  for (const [team_key, list] of bySite.entries()) {
    const acct = accountByKey.get(team_key);
    const city = (acct?.city ?? "").trim();
    const state = (acct?.state ?? "").trim();
    const city_state = city && state ? `${city}, ${state}` : city || team_key;
    const name = (acct?.name ?? "").trim() || team_key;
    const region = (acct?.region ?? null) || null;
    const totalCount = list.length;
    const waitingItems = list.reduce((n, r) => n + r.waiting_count, 0);
    // site_manager viewers see only hourly team members; use the
    // "hourly team" override on their own site panel.
    const isManagerOwnSite = viewer.role === "site_manager" && team_key === viewer.account_key;
    const level = levelFor(team_key, acct, isManagerOwnSite);

    const entry: SiteNavEntry = {
      account_key: team_key,
      name,
      place: city_state,
      leader_name: siteLeaders.get(team_key) ?? null,
      region,
      count: totalCount,
      waiting: waitingItems,
      mark: markFor(team_key),
      city,
      city_state,
      level,
    };
    sites.push(entry);

    const sorted = [...list].sort((a, b) => {
      const sl = (b.is_site_leader ? 1 : 0) - (a.is_site_leader ? 1 : 0);
      if (sl !== 0) return sl;
      const sa = (b.is_salaried ? 1 : 0) - (a.is_salaried ? 1 : 0);
      if (sa !== 0) return sa;
      return a.display_name.localeCompare(b.display_name);
    });
    // Exclude the viewer from the panel; the "You" card renders them.
    const panelPeople = sorted.filter((r) => r.worker_id !== viewer.worker_id);
    // dividerAt: index of the first hourly row when at least one
    // salaried row comes before it. Mirrors the render's
    // `.kf-pe-person--divider` class placement.
    let dividerAt: number | null = null;
    for (let i = 0; i < panelPeople.length; i += 1) {
      if (!panelPeople[i].is_salaried) {
        if (i > 0 && panelPeople[i - 1].is_salaried) dividerAt = i;
        break;
      }
    }
    panels[team_key] = { entry, people: panelPeople, dividerAt };
  }

  // Sort sites: corporate first (CORP region first), then by region,
  // then by name.
  sites.sort((a, b) => {
    const ra = a.region ?? "ZZ";
    const rb = b.region ?? "ZZ";
    if (ra !== rb) return ra.localeCompare(rb);
    return a.name.localeCompare(b.name);
  });

  // T2.2 default panel: first site with pending > 0 (display order),
  // else the viewer's own account_key when it is in the sitenav,
  // else the first site.
  const firstPending = sites.find((s) => s.waiting > 0);
  const viewerSite = sites.find((s) => s.account_key === viewer.account_key);
  const defaultSiteKey = (firstPending?.account_key)
    ?? (viewerSite?.account_key)
    ?? (sites[0]?.account_key)
    ?? "";

  // T3 Part 0 #2 (2026-11-13). Club name for a single-site viewer.
  // SL and SM live on one site; use its accounts.name so the phone
  // head reads "St Louis Cardinals · 9 people" instead of leaking
  // the account key "STL - FL". Null for corporate + RD (they see
  // multiple sites and do not get a single-site phone head).
  const viewerSiteName = (viewer.role === "site_leader" || viewer.role === "site_manager")
    ? ((accountByKey.get(viewer.account_key)?.name ?? "").trim() || viewer.account_key)
    : null;

  const total_pending = inScopeRows.reduce((s, r) => s + r.waiting_count, 0);

  // T2.2.2 (2026-11-13). Count pending items that have waited
  // >= LATE_DAYS. The band warn tone keys off this (not on the full
  // `pending` count), so a fresh request never warns and a 14-day-old
  // request always does. Same threshold as the card's per-row `late`
  // flag - one constant, see src/lib/people/thresholds.ts.
  let total_pending_late = 0;
  for (const r of inScopeRows) {
    const items = waitingByPerson.get(r.worker_id) ?? [];
    for (const item of items) if (isLate(item.submitted_at)) total_pending_late += 1;
  }

  return {
    viewer,
    // T2.2: the site-nav is hidden when exactly one site is in
    // scope (site_leader + site_manager). Returning `sites` as []
    // in that case keeps the earlier contract (MyTeam uses .length
    // to decide whether to render the nav column).
    sites: sites.length > 1 ? sites : [],
    people: flatOut,
    totals: { people: inScopeRows.length, pending: total_pending, pending_late: total_pending_late },
    panels,
    defaultSiteKey,
    selfRow,
    viewerSiteName,
  };
}
