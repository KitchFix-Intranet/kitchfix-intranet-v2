"use client";

// My team client island. Pure UI: the roster + site map have
// already been scope-filtered + contact-rule-stripped upstream.
// The island handles the three interactive bits:
//   - search (name / title / site, within scope)
//   - site switch when more than one site is in scope
//   - navigate to ?card=<worker_id> on row click (soft-nav)
//
// No fetch, no mutation, no state outside the three params above.

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search as SearchIcon, ChevronRight, Clock } from "lucide-react";
import type { RosterPerson, SiteNavEntry } from "@/lib/people/types";
import { fmtShort, fmtDaysWaiting } from "@/lib/people/dates";

type Props = {
  people: RosterPerson[];
  sites: SiteNavEntry[];
  viewerWorkerId: string;
};

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="kf-skew-tag"><span>{children}</span></span>;
}

function PersonRow({
  p, isSelf, onOpen,
}: {
  p: RosterPerson; isSelf: boolean; onOpen: (worker_id: string) => void;
}) {
  const subtitle = [p.title, p.account_key, p.account_region].filter(Boolean).join(" - ") || "No role";
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
            {fmtShort(p.waiting.submitted_at)} - {fmtDaysWaiting(p.waiting.submitted_at)}
          </span>
        </span>
      ) : null}
      <ChevronRight size={16} strokeWidth={1.5} aria-hidden style={{ color: "var(--sp-muted)" }} />
    </button>
  );
}

export function MyTeam({ people, sites, viewerWorkerId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const siteParam = sp.get("site") ?? "";
  const asParam = sp.get("as") ?? "";
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
  const pending = filtered.reduce((n, p) => n + (p.waiting_count > 0 ? 1 : 0), 0);

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
            <span className="kf-pe-sitenav__name">All sites</span>
            <span className="kf-pe-sitenav__count">{people.length}</span>
          </button>
          {siteGroups.map(([region, list]) => (
            <div key={region || "no-region"}>
              <div className="kf-pe-sitenav__region">
                <span>{region || "Other"}</span>
                <b>{list.reduce((n, s) => n + s.count, 0)}</b>
              </div>
              {list.map((s) => (
                <button
                  key={s.account_key}
                  type="button"
                  className="kf-pe-sitenav__item"
                  onClick={() => router.push(buildHref({ site: s.account_key }))}
                  aria-current={siteParam === s.account_key ? "true" : "false"}
                >
                  <span className="kf-pe-sitenav__name">{s.name}</span>
                  <span className="kf-pe-sitenav__count">
                    {s.count}
                    {s.waiting > 0 ? <b> {s.waiting}</b> : null}
                  </span>
                </button>
              ))}
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
              {pending > 0 ? ` - ${pending} pending` : ""}
            </span>
          </header>
          {filtered.length === 0 ? (
            <div className="kf-pe-empty">
              <strong>Nobody matches</strong>
              <span>Try a shorter search, or clear the filter.</span>
            </div>
          ) : (
            filtered.map((p, i) => (
              <PersonRow
                key={p.worker_id}
                p={p}
                isSelf={p.worker_id === viewerWorkerId}
                onOpen={openCard}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
