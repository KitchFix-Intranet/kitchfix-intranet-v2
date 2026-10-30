// src/lib/academy/team.ts
//
// Scoped team loader for /academy/team. Returns the viewer's "my
// team" with per-person compliance. The gate (`requireAppAccess`)
// already decides WHO may call this; the loader decides WHICH
// people appear.
//
// Scope rules (strict, same humans-not-stints dedup as People):
//   owner           -> every ACTIVE person, picker lets them narrow
//                      by region (region:<name>) or site (site:<key>).
//   lead - region   -> every ACTIVE person at an account whose
//                      region is one of the viewer's academy_region_
//                      leads rows.
//   lead - site     -> every ACTIVE person at the viewer's own
//                      account_key when is_site_leader = true.
//   lead - manager  -> every ACTIVE person whose
//                      manager_worker_id = the viewer's worker_id.
//                      Direct reports only this train.
//   lead - union    -> owners of multiple signals see the UNION of
//                      the above, de-duped by person_id.
//
// Owner picker scopes:
//   "all"              -> every active person (default)
//   "region:<Region>"  -> every active person at an account in that region
//   "site:<team_key>"  -> every active person at that account_key
//
// The scope filter is applied BEFORE compliance - the compliance
// helper only ever sees the final worker_id list, so it cannot
// widen the view.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { computeComplianceForWorkers } from "@/lib/academy/compliance";
import type { ViewerAccess } from "@/lib/academy/access";

export interface TeamPersonRow {
  person_id: string | null;
  worker_id: string;
  work_email: string | null;
  display_name: string | null;
  title: string | null;
  account_key: string | null;
  region: string | null;
  is_salaried: boolean;
  worker_class: "salaried" | "hourly";
  is_site_leader: boolean;
  status: string | null;
  outstanding: number;
  signed: number;
  waived: number;
  last_signed_at: string | null;
  next_due_at: string | null;
}

// Picker option for the owner's scope selector. "all" plus one per
// region plus one per site that has at least one active person.
export interface ScopeOption {
  value: string;      // "all" | "region:East" | "site:TBR - FL"
  label: string;      // "All teams" | "East (region)" | "TBR - FL (site)"
  kind: "all" | "region" | "site";
  count: number;      // number of active people under this scope
}

export interface TeamHeader {
  title: string;              // "Your team" | "All teams" | "East" | "TBR - FL"
  subtitle: string | null;    // "Region lead" | "Site leader" | "Manager" | mix
  viewerIsOwner: boolean;     // true -> show picker
  viewerIsLead: boolean;      // informative; false for owner
  activeScope: string;        // "all" | "region:East" | "site:TBR - FL" | "manager" | "lead-union"
  leadReasons: ViewerAccess["leadReasons"];
}

export interface TeamView {
  header: TeamHeader;
  roster: TeamPersonRow[];
  scopeOptions: ScopeOption[]; // owner only; empty [] for leads
}

type PeopleRaw = {
  worker_id: string;
  work_email: string | null;
  display_name: string | null;
  title: string | null;
  account_key: string | null;
  manager_worker_id: string | null;
  is_salaried: boolean | null;
  is_site_leader: boolean | null;
  status: string | null;
  region: string | null;
};

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
const CHUNK = 500;

export interface LoadTeamOpts {
  viewer: ViewerAccess;
  // Picker value for owners; ignored for leads (their scope is
  // intrinsic). Shape: "all" | "region:<Region>" | "site:<team_key>".
  scope?: string;
  supa?: SupabaseClient;
}

export async function loadTeam(opts: LoadTeamOpts): Promise<TeamView> {
  const { viewer } = opts;
  const scope = opts.scope ?? "all";
  const supa = opts.supa ?? serviceClient();

  if (viewer.role !== "owner" && viewer.role !== "lead") {
    // Defense in depth. The gate should have 404'd already; this
    // loader never widens.
    return emptyView(viewer);
  }

  // Full active roster + accounts.region lookup. The team scope is
  // a filter over this set, never a widening of it.
  const [peopleQ, accountsQ] = await Promise.all([
    supa
      .from("people")
      .select(
        "worker_id, work_email, display_name, title, account_key, manager_worker_id, is_salaried, is_site_leader, status, region",
      )
      .eq("status", "ACTIVE")
      .order("display_name", { ascending: true }),
    supa.from("accounts").select("team_key, region").neq("active", false),
  ]);
  if (peopleQ.error) throw new Error(`[team] people: ${peopleQ.error.message}`);
  if (accountsQ.error) throw new Error(`[team] accounts: ${accountsQ.error.message}`);
  const allPeople = (peopleQ.data as PeopleRaw[]) || [];
  const regionByAccount = new Map<string, string | null>();
  for (const a of (accountsQ.data as Array<{ team_key: string; region: string | null }>) || []) {
    regionByAccount.set(a.team_key, a.region);
  }
  function rowRegion(p: PeopleRaw): string | null {
    return (p.account_key ? regionByAccount.get(p.account_key) ?? null : null) || p.region;
  }

  // Scope resolution.
  let scoped: PeopleRaw[] = [];
  let header: TeamHeader;

  if (viewer.role === "owner") {
    const sel = normalizeScope(scope);
    if (sel.kind === "all") {
      scoped = allPeople;
      header = {
        title: "All teams",
        subtitle: null,
        viewerIsOwner: true,
        viewerIsLead: false,
        activeScope: "all",
        leadReasons: null,
      };
    } else if (sel.kind === "region") {
      scoped = allPeople.filter((p) => rowRegion(p) === sel.value);
      header = {
        title: sel.value,
        subtitle: "Region (owner preview)",
        viewerIsOwner: true,
        viewerIsLead: false,
        activeScope: `region:${sel.value}`,
        leadReasons: null,
      };
    } else {
      // site
      scoped = allPeople.filter((p) => p.account_key === sel.value);
      header = {
        title: sel.value,
        subtitle: "Site (owner preview)",
        viewerIsOwner: true,
        viewerIsLead: false,
        activeScope: `site:${sel.value}`,
        leadReasons: null,
      };
    }
  } else {
    // lead: union of (region lead) + (site leader) + (manager).
    const vi = viewer.identity;
    const reasons = viewer.leadReasons;
    const includeByWorker = new Set<string>();

    // Region lead: pull every region whose email matches the viewer.
    // leadReasons.isRegionLead is a boolean - fetch the regions to
    // know WHICH regions, since the viewer could lead more than one.
    if (reasons?.isRegionLead) {
      const regQ = await supa
        .from("academy_region_leads")
        .select("region")
        .eq("email", viewer.email);
      if (regQ.error) throw new Error(`[team] region leads: ${regQ.error.message}`);
      const regions = new Set(
        ((regQ.data as Array<{ region: string }>) || []).map((r) => r.region),
      );
      for (const p of allPeople) {
        const r = rowRegion(p);
        if (r && regions.has(r)) includeByWorker.add(p.worker_id);
      }
    }
    // Site leader: viewer's own account_key.
    if (reasons?.isSiteLeader && vi?.accountKey) {
      for (const p of allPeople) {
        if (p.account_key === vi.accountKey) includeByWorker.add(p.worker_id);
      }
    }
    // Manager: direct reports whose manager_worker_id = viewer.workerId.
    if (reasons?.hasDirectReports && vi?.workerId) {
      for (const p of allPeople) {
        if (p.manager_worker_id === vi.workerId) includeByWorker.add(p.worker_id);
      }
    }

    scoped = allPeople.filter((p) => includeByWorker.has(p.worker_id));
    const subBits: string[] = [];
    if (reasons?.isRegionLead) subBits.push("Region lead");
    if (reasons?.isSiteLeader) subBits.push("Site leader");
    if (reasons?.hasDirectReports) subBits.push("Manager");
    header = {
      title: "Your team",
      subtitle: subBits.length ? subBits.join(" - ") : null,
      viewerIsOwner: false,
      viewerIsLead: true,
      activeScope: "lead-union",
      leadReasons: reasons,
    };
  }

  // Dedup by person_id (seasonal rehires with two active stints
  // would otherwise appear twice).
  const workerIds = scoped.map((p) => p.worker_id);
  const stintChunks = chunk(workerIds, CHUNK).map((c) =>
    supa.from("academy_person_stints").select("worker_id, person_id").in("worker_id", c) as unknown as Promise<{ data: Array<{ worker_id: string; person_id: string | null }> | null; error: { message: string } | null }>
  );
  const [stintResults, counts] = await Promise.all([
    Promise.all(stintChunks),
    computeComplianceForWorkers(supa, workerIds),
  ]);
  for (const r of stintResults) if (r.error) throw new Error(`[team] stints: ${r.error.message}`);
  const personIdByWorker = new Map<string, string | null>();
  for (const r of stintResults) {
    for (const row of r.data || []) personIdByWorker.set(row.worker_id, row.person_id ?? null);
  }

  const seen = new Set<string>();
  const roster: TeamPersonRow[] = [];
  for (const p of scoped) {
    const personId = personIdByWorker.get(p.worker_id) ?? null;
    if (personId && seen.has(personId)) continue;
    if (personId) seen.add(personId);
    const c = counts.get(p.worker_id) ?? {
      outstanding: 0,
      signed: 0,
      waived: 0,
      last_signed_at: null,
      next_due_at: null,
    };
    roster.push({
      person_id: personId,
      worker_id: p.worker_id,
      work_email: p.work_email,
      display_name: p.display_name,
      title: p.title,
      account_key: p.account_key,
      region: rowRegion(p),
      is_salaried: !!p.is_salaried,
      worker_class: p.is_salaried ? "salaried" : "hourly",
      is_site_leader: !!p.is_site_leader,
      status: p.status,
      outstanding: c.outstanding,
      signed: c.signed,
      waived: c.waived,
      last_signed_at: c.last_signed_at,
      next_due_at: c.next_due_at,
    });
  }

  // Picker options: owner-only. Count active people per region/site
  // across the FULL active roster so a locked scope with zero people
  // still shows the option (empty-state is on the view, not the
  // picker list). Site counts limited to accounts with at least one
  // active person so the dropdown stays operator-manageable.
  const scopeOptions: ScopeOption[] = [];
  if (viewer.role === "owner") {
    scopeOptions.push({
      value: "all",
      label: "All teams",
      kind: "all",
      count: allPeople.length,
    });
    const regionCount = new Map<string, number>();
    const siteCount = new Map<string, number>();
    for (const p of allPeople) {
      const r = rowRegion(p);
      if (r) regionCount.set(r, (regionCount.get(r) || 0) + 1);
      if (p.account_key) siteCount.set(p.account_key, (siteCount.get(p.account_key) || 0) + 1);
    }
    for (const r of [...regionCount.keys()].sort()) {
      scopeOptions.push({
        value: `region:${r}`,
        label: `${r} (region)`,
        kind: "region",
        count: regionCount.get(r) || 0,
      });
    }
    for (const k of [...siteCount.keys()].sort()) {
      scopeOptions.push({
        value: `site:${k}`,
        label: `${k} (site)`,
        kind: "site",
        count: siteCount.get(k) || 0,
      });
    }
  }

  return { header, roster, scopeOptions };
}

function normalizeScope(raw: string): { kind: "all" | "region" | "site"; value: string } {
  const s = (raw || "all").trim();
  if (!s || s === "all") return { kind: "all", value: "" };
  if (s.startsWith("region:")) return { kind: "region", value: s.slice("region:".length).trim() };
  if (s.startsWith("site:")) return { kind: "site", value: s.slice("site:".length).trim() };
  return { kind: "all", value: "" };
}

function emptyView(viewer: ViewerAccess): TeamView {
  return {
    header: {
      title: viewer.role === "owner" ? "All teams" : "Your team",
      subtitle: null,
      viewerIsOwner: viewer.role === "owner",
      viewerIsLead: viewer.role === "lead",
      activeScope: "all",
      leadReasons: viewer.leadReasons,
    },
    roster: [],
    scopeOptions: [],
  };
}
