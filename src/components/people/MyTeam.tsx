"use client";

// My team client island. Pure UI: the roster + site map have
// already been scope-filtered + contact-rule-stripped upstream.
// The island handles the three interactive bits:
//   - search (name / title / site, within scope)
//   - site switch when more than one site is in scope
//   - navigate to ?card=<worker_id> on row click (soft-nav)
//
// No fetch, no mutation, no state outside the three params above.
//
// T2.1 (2026-11-12):
//   - Fix 5: subline is "<title> - <account_key>" with no region,
//     and drops account_key for single-site viewers (site_leader +
//     site_manager).
//   - Fix 6: person names wrap instead of truncate (CSS handles it;
//     markup already carries .kf-pe-person__who b).
//   - Fix 7: roster-head "pending" is the sum of waiting ITEMS,
//     not the count of distinct people.
//   - Fix 4: site nav rows render place + leader + N people.

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search as SearchIcon, ChevronRight, Clock } from "lucide-react";
import type { RosterPerson, SiteNavEntry } from "@/lib/people/types";
import { fmtShort, fmtDaysWaiting } from "@/lib/people/dates";

type Props = {
  people: RosterPerson[];
  sites: SiteNavEntry[];
  viewerWorkerId: string;
  // T2.1 fix 5. True for site_leader + site_manager (the viewer
  // only ever sees one site). Drops account_key from every row's
  // subline so the subline becomes title-only.
  singleSiteView: boolean;
};

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="kf-skew-tag"><span>{children}</span></span>;
}

// T2.1 fix 5. Subline = title, one separator, account_key. No
// region. Never the same word twice. Single-site viewers get
// title-only. Separator is the middle dot " · " per Kevin ruling
// 2026-11-12 ("Wherever My team joins separate facts on one line,
// use the render's middle dot"). Account keys keep their own
// hyphens ("TXR - AZ") since those hyphens are part of the key.
function sublineFor(p: RosterPerson, singleSiteView: boolean): string {
  const title = (p.title ?? "").trim();
  const acct = (p.account_key ?? "").trim();
  if (singleSiteView) return title || "No role";
  if (!title && !acct) return "No role";
  if (!title) return acct;
  if (!acct || acct === title) return title;
  return `${title} · ${acct}`;
}

function PersonRow({
  p, isSelf, singleSiteView, onOpen,
}: {
  p: RosterPerson; isSelf: boolean; singleSiteView: boolean; onOpen: (worker_id: string) => void;
}) {
  const subtitle = sublineFor(p, singleSiteView);
  return (
    <button
      type="button"
      className={`kf-pe-person${isSelf ? " kf-pe-person--self" : ""}`}
      onClick={() => onOpen(p.worker_id)}
      aria-label={`Open ${p.display_name || "person"}`}
    >
      <span className="kf-pe-ava" aria-hidden>{p.initials}</span>
      <span className="kf-pe-person__who">
        <b>{p.display_name || "Unnamed"}</b>
        <small>{subtitle}</small>
      </span>
      <span className="kf-pe-person__tags" aria-label="Tags">
        {isSelf ? <Tag>You</Tag> : null}
        {p.is_site_leader ? <Tag>Site leader</Tag> : null}
        {p.is_regional_director ? <Tag>Regional</Tag> : null}
        {p.is_salaried ? <Tag>Salaried</Tag> : null}
      </span>
      {p.waiting ? (
        <span className="kf-pe-flight" aria-label="Pending request">
          <Clock size={14} strokeWidth={1.5} aria-hidden />
          <span className="kf-pe-flight__what">
            {fmtShort(p.waiting.submitted_at)} · {fmtDaysWaiting(p.waiting.submitted_at)}
          </span>
        </span>
      ) : null}
      <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="kf-pe-person__chev" />
    </button>
  );
}

export function MyTeam({ people, sites, viewerWorkerId, singleSiteView }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const siteParam = sp.get("site") ?? "";
  const [query, setQuery] = useState("");

  // Build a stable query-string helper so clicks keep ?as= in play
  // during owner preview + switch the ?site= filter cleanly.
  const buildHref = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    return s ? `${pathname}?${s}` : pathname;
  }, [sp, pathname]);

  const openCard = useCallback((worker_id: string) => {
    router.push(buildHref({ card: worker_id }));
  }, [router, buildHref]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = people;
    if (siteParam) base = base.filter((p) => p.account_key === siteParam);
    if (!q) return base;
    return base.filter((p) => {
      const hay =
        (p.display_name || "").toLowerCase() + " " +
        (p.title || "").toLowerCase() + " " +
        (p.account_key || "").toLowerCase() + " " +
        (p.account_region || "").toLowerCase();
      return hay.includes(q);
    });
  }, [people, query, siteParam]);

  // Region grouping for the site nav. Corporate first by region key
  // ordering upstream; we just render the groups.
  const siteGroups = useMemo(() => {
    const m = new Map<string, SiteNavEntry[]>();
    for (const s of sites) {
      const key = s.region ?? "";
      const g = m.get(key) ?? [];
      g.push(s);
      m.set(key, g);
    }
    return [...m.entries()];
  }, [sites]);

  const hasMultipleSites = sites.length > 0; // loader empties when 1
  const total = filtered.length;
  // T2.1 fix 7: "N pending" on the roster head counts items, not
  // people - same grain as the band total and the site-list sum.
  const pendingItems = filtered.reduce((n, p) => n + p.waiting_count, 0);

  return (
    <div className="kf-pe-cols">
      {hasMultipleSites ? (
        <aside className="kf-pe-sitenav" aria-label="Sites">
          <button
            type="button"
            className="kf-pe-sitenav__item"
            onClick={() => router.push(buildHref({ site: null }))}
            aria-current={siteParam === "" ? "true" : "false"}
          >
            <span className="kf-pe-sitenav__who">
              <b>All sites</b>
              <small>Everyone in scope</small>
            </span>
            <span className="kf-pe-sitenav__count">{people.length}</span>
          </button>
          {siteGroups.map(([region, list]) => (
            <div key={region || "no-region"}>
              <div className="kf-pe-sitenav__region">
                <span>{region || "Other"}</span>
                <b>{list.reduce((n, s) => n + s.count, 0)}</b>
              </div>
              {list.map((s) => {
                // T2.1 fix 4. Two-line label: name + (place - leader
                // - N people). `place` falls back to account_key when
                // accounts has no city; `leader_name` may be null.
                const leader = s.leader_name ? s.leader_name : "No site leader";
                const nPeople = `${s.count} ${s.count === 1 ? "person" : "people"}`;
                const subParts = [s.place, leader, nPeople].filter(Boolean);
                return (
                  <button
                    key={s.account_key}
                    type="button"
                    className="kf-pe-sitenav__item"
                    onClick={() => router.push(buildHref({ site: s.account_key }))}
                    aria-current={siteParam === s.account_key ? "true" : "false"}
                  >
                    <span className="kf-pe-sitenav__who">
                      <b>{s.name}</b>
                      <small>{subParts.join(" · ")}</small>
                    </span>
                    <span className="kf-pe-sitenav__count">
                      {s.count}
                      {s.waiting > 0 ? <b> {s.waiting}</b> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
      ) : null}

      <div>
        <label className="kf-pe-field kf-pe-field--search" aria-label="Find a person, a role or a site">
          <SearchIcon size={16} strokeWidth={1.5} aria-hidden />
          <input
            type="search"
            placeholder="Find a person, a role or a site"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <section className="kf-pe-roster" aria-label="Roster">
          <header className="kf-pe-roster__head">
            <h3>Your team</h3>
            <span className="kf-pe-roster__meta">
              {total} {total === 1 ? "person" : "people"}
              {pendingItems > 0 ? ` · ${pendingItems} pending` : ""}
            </span>
          </header>
          {filtered.length === 0 ? (
            <div className="kf-pe-empty">
              <strong>Nobody matches</strong>
              <span>Try a shorter search, or clear the filter.</span>
            </div>
          ) : (
            filtered.map((p) => (
              <PersonRow
                key={p.worker_id}
                p={p}
                isSelf={p.worker_id === viewerWorkerId}
                singleSiteView={singleSiteView}
                onOpen={openCard}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
