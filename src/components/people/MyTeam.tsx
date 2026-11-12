"use client";

// My team client island (T2.2, 2026-11-12). Matches the approved
// render structure, class by class:
//
//   - Top grid: search field + a "You" card (the viewer's own row,
//     pinned above the team). .kf-pe-teamgrid.kf-pe-teamgrid--top.
//   - Main grid on desktop: .kf-pe-sitenav (left) + .kf-pe-sitepanels
//     (right) via .kf-pe-teamgrid.
//   - Phone: .kf-pe-sitestack with a .kf-pe-sitehead toggle per site.
//   - Search: non-empty query shows matches grouped by site head
//     across all in-scope sites; clearing returns to the selected
//     panel.
//
// Row order inside a site (from the loader): site_leader -> salaried
// -> hourly, with a .kf-pe-person--divider class before the first
// hourly row (when any salaried row preceded it). Separators between
// facts: middle dot " · ".

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search as SearchIcon, ChevronRight, ChevronDown, Plus } from "lucide-react";
import type { RosterPerson, SelfRosterPerson, SiteNavEntry, SitePanel } from "@/lib/people/types";

type Props = {
  // T2.2.1: the viewer's own row carries a WaitingItem (with label);
  // every other row in `panels` carries a RosterWaiting (no label).
  // The type split is enforced at build time - PersonRow below cannot
  // read a label off a non-self row because the field is not in the
  // type.
  selfRow: SelfRosterPerson | null;
  sites: SiteNavEntry[];                 // [] when only one site in scope
  panels: Record<string, SitePanel>;
  defaultSiteKey: string;
  viewerWorkerId: string;
  singleSiteView: boolean;
};

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="kf-skew-tag"><span>{children}</span></span>;
}

// ONE tag per row per the render:
//   - site_leader   -> "Site leader"
//   - salaried      -> "Salaried" (but not for corporate people)
//   - everything    -> nothing
function tagFor(p: RosterPerson): React.ReactNode | null {
  if (p.is_site_leader) return <Tag>Site leader</Tag>;
  if (p.is_salaried && !p.is_corp) return <Tag>Salaried</Tag>;
  return null;
}

// Subline: title only (render rule: no site repeated on each row
// because the panel head already names the site).
function sublineFor(p: RosterPerson): string {
  return (p.title ?? "").trim() || "No role";
}

function PendingPill({ label }: { label: string }) {
  return (
    <span className="kf-pill kf-pill--info kf-pe-pill">
      <i className="kf-pe-dot" aria-hidden />
      {label}
    </span>
  );
}

// T2.2.1 (2026-11-12). The pending `label` (.kf-pe-flight__what)
// renders ONLY on the viewer's own row (the "You" card). Every
// other row renders the Pending pill alone, matching the render
// (flight(name, detail=False) for non-self people).
//
// The label is NOT in the roster payload for non-self rows at all -
// see RosterPerson.waiting: RosterWaiting (no label field) vs
// SelfRosterPerson.waiting: WaitingItem (has label) in types.ts.
// The caller passes `pendingLabel` only on the You card.
function PersonRow({
  p, isSelf, divider, pendingLabel, onOpen,
}: {
  p: RosterPerson; isSelf: boolean; divider: boolean;
  pendingLabel?: string | null;
  onOpen: (worker_id: string) => void;
}) {
  const cls = [
    "kf-pe-person",
    isSelf ? "kf-pe-person--you" : "",
    divider ? "kf-pe-person--divider" : "",
  ].filter(Boolean).join(" ");
  return (
    <li>
      <button
        type="button"
        className={cls}
        onClick={() => onOpen(p.worker_id)}
        aria-label={`Open ${p.display_name || "person"}`}
      >
        <span className="kf-pe-ava" aria-hidden>{p.initials}</span>
        <span className="kf-pe-person__who">
          <b>{p.display_name || "Unnamed"}</b>
          <small>{sublineFor(p)}</small>
        </span>
        <span className="kf-pe-person__tags" aria-label="Tags">
          {tagFor(p)}
        </span>
        {p.waiting ? (
          <span className="kf-pe-flight" aria-label="Pending request">
            {pendingLabel ? (
              <span className="kf-pe-flight__what">{pendingLabel}</span>
            ) : null}
            <PendingPill label="Pending" />
          </span>
        ) : (
          <span className="kf-pe-flight" aria-hidden />
        )}
        <ChevronRight size={18} strokeWidth={1.5} aria-hidden className="kf-pe-person__chev" />
      </button>
    </li>
  );
}

function SiteHeadStatic({ entry }: { entry: SiteNavEntry }) {
  const subParts = [entry.city_state, entry.level, `${entry.count} ${entry.count === 1 ? "person" : "people"}`]
    .filter(Boolean);
  return (
    <div className="kf-pe-sitehead kf-pe-sitehead--static">
      <span className="kf-pe-mark" aria-hidden>{entry.mark}</span>
      <span className="kf-pe-sitehead__who">
        <b>{entry.name}</b>
        <small>{subParts.join(" · ")}</small>
      </span>
      {entry.waiting > 0 ? (
        <span className="kf-pe-sitehead__flight">
          <PendingPill label={`${entry.waiting} pending`} />
        </span>
      ) : null}
    </div>
  );
}

function SitePanelView({
  panel, viewerWorkerId, onOpen,
}: {
  panel: SitePanel; viewerWorkerId: string;
  onOpen: (worker_id: string) => void;
}) {
  return (
    <section className="kf-pe-site kf-pe-site--panel is-active" aria-label={`Site: ${panel.entry.name}`}>
      <SiteHeadStatic entry={panel.entry} />
      <ul className="kf-pe-roster">
        {panel.people.map((p, i) => (
          <PersonRow
            key={p.worker_id}
            p={p}
            isSelf={p.worker_id === viewerWorkerId}
            divider={panel.dividerAt === i}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

function PhoneSiteBlock({
  panel, defaultOpen, onOpen,
}: { panel: SitePanel; defaultOpen: boolean; onOpen: (worker_id: string) => void }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const subParts = [panel.entry.city_state, panel.entry.level, `${panel.entry.count} ${panel.entry.count === 1 ? "person" : "people"}`]
    .filter(Boolean);
  return (
    <section className="kf-pe-site" aria-label={`Site: ${panel.entry.name}`}>
      <button
        type="button"
        className="kf-pe-sitehead"
        aria-expanded={expanded ? "true" : "false"}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="kf-pe-mark" aria-hidden>{panel.entry.mark}</span>
        <span className="kf-pe-sitehead__who">
          <b>{panel.entry.name}</b>
          <small>{subParts.join(" · ")}</small>
        </span>
        {panel.entry.waiting > 0 ? (
          <span className="kf-pe-sitehead__flight">
            <PendingPill label={`${panel.entry.waiting} pending`} />
          </span>
        ) : null}
        <ChevronDown size={18} strokeWidth={1.5} aria-hidden className="kf-pe-sitehead__chev" />
      </button>
      {expanded ? (
        <ul className="kf-pe-roster">
          {panel.people.map((p, i) => (
            <PersonRow
              key={p.worker_id}
              p={p}
              isSelf={false /* self is on the You card above */}
              divider={panel.dividerAt === i}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MyTeam({ selfRow, sites, panels, defaultSiteKey, viewerWorkerId, singleSiteView }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const siteParam = sp.get("site") ?? "";
  const [query, setQuery] = useState("");

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

  // Active panel selection: ?site= wins when valid; otherwise the
  // loader-computed defaultSiteKey (first site with pending; else
  // viewer's own; else first site).
  const activeSiteKey = siteParam && panels[siteParam] ? siteParam : defaultSiteKey;
  const activePanel = panels[activeSiteKey];

  // Flat all-in-scope list for across-site search (excludes self;
  // the "You" card is above so self never appears as a match).
  const allPeople = useMemo(() => {
    const out: Array<{ p: RosterPerson; entry: SiteNavEntry }> = [];
    for (const key of Object.keys(panels)) {
      const panel = panels[key];
      for (const p of panel.people) out.push({ p, entry: panel.entry });
    }
    return out;
  }, [panels]);

  const q = query.trim().toLowerCase();
  const searchHits = useMemo(() => {
    if (!q) return [];
    const matches = allPeople.filter(({ p }) => {
      const hay =
        (p.display_name || "").toLowerCase() + " " +
        (p.title || "").toLowerCase() + " " +
        (p.account_key || "").toLowerCase() + " " +
        (p.account_region || "").toLowerCase();
      return hay.includes(q);
    });
    // Group by account_key preserving the sites' authored order.
    const byKey = new Map<string, Array<RosterPerson>>();
    const order: string[] = [];
    const seen = new Set<string>();
    for (const { p } of matches) {
      if (!seen.has(p.account_key)) { seen.add(p.account_key); order.push(p.account_key); }
      const l = byKey.get(p.account_key) ?? [];
      l.push(p);
      byKey.set(p.account_key, l);
    }
    return order.map((k) => ({ entry: panels[k].entry, people: byKey.get(k) ?? [] }));
  }, [allPeople, panels, q]);

  return (
    <>
      {/* Top grid: search + You card. */}
      <div className="kf-pe-teamgrid kf-pe-teamgrid--top">
        <label className="kf-pe-field kf-pe-field--search kf-pe-search" aria-label="Find a person, a role or a site">
          <span className="kf-pe-search__ico" aria-hidden>
            <SearchIcon size={18} strokeWidth={1.5} />
          </span>
          <input
            type="search"
            placeholder="Find a person, a role or a site"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {selfRow ? (
          <section className="kf-pe-site kf-pe-site--you" aria-label="You">
            <ul className="kf-pe-roster">
              <PersonRow
                p={selfRow}
                isSelf={true}
                divider={false}
                pendingLabel={selfRow.waiting?.label ?? null}
                onOpen={openCard}
              />
            </ul>
          </section>
        ) : null}
      </div>

      {/* Main grid (desktop). When only one site is in scope the grid
       * collapses to one column so the panel owns the full width. */}
      <div className={`kf-pe-teamgrid${singleSiteView ? " kf-pe-teamgrid--solo" : ""}`}>
        {!singleSiteView && sites.length > 0 ? (
          <nav className="kf-pe-sitenav" aria-label="Sites">
            {/* Group by region. Region header shows "<Region> · <N>"
             * where N is the sum of counts for that region. */}
            {(() => {
              const groups = new Map<string, SiteNavEntry[]>();
              const order: string[] = [];
              for (const s of sites) {
                const key = s.region ?? "";
                if (!groups.has(key)) { groups.set(key, []); order.push(key); }
                groups.get(key)!.push(s);
              }
              return order.map((region) => {
                const list = groups.get(region)!;
                const sum = list.reduce((n, s) => n + s.count, 0);
                const label = region === "CORP" ? "Corporate" : (region || "Other");
                return (
                  <div key={region || "no-region"}>
                    <div className="kf-pe-sitenav__region">
                      {label} <b>· {sum}</b>
                    </div>
                    {list.map((s) => {
                      const isActive = s.account_key === activeSiteKey;
                      const subParts = s.leader_name
                        ? [s.leader_name, `${s.count} ${s.count === 1 ? "person" : "people"}`]
                        : [`${s.count} ${s.count === 1 ? "person" : "people"}`];
                      const isEmpty = s.count === 0;
                      return (
                        <button
                          key={s.account_key}
                          type="button"
                          className={`kf-pe-sitenav__item${isEmpty ? " is-empty" : ""}`}
                          onClick={() => router.push(buildHref({ site: s.account_key }))}
                          aria-current={isActive ? "true" : "false"}
                        >
                          <span className="kf-pe-mark" aria-hidden>{s.mark}</span>
                          <span className="kf-pe-sitenav__who">
                            <b>
                              {s.name}
                              {s.city ? <small className="kf-pe-sitenav__place">{s.city}</small> : null}
                            </b>
                            <small>{isEmpty ? "Seasonal" : subParts.join(" · ")}</small>
                          </span>
                          <span className="kf-pe-sitenav__slot">
                            {s.waiting > 0 ? (
                              <span
                                className="kf-pill kf-pill--info kf-pe-pill kf-pe-pill--count"
                                title={`${s.waiting} pending`}
                              >
                                {s.waiting}
                              </span>
                            ) : null}
                          </span>
                          <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="kf-pe-sitenav__chev" />
                        </button>
                      );
                    })}
                  </div>
                );
              });
            })()}
          </nav>
        ) : null}

        {/* Site panels (desktop). When searching, show matches grouped
         * by site head across all sites; else show the active panel. */}
        <div className="kf-pe-sitepanels" aria-live="polite">
          {q ? (
            searchHits.length === 0 ? (
              <section className="kf-pe-site">
                <div className="kf-pe-empty">
                  <strong>Nobody matches</strong>
                  <span>Try a shorter search, or clear the filter.</span>
                </div>
              </section>
            ) : (
              searchHits.map(({ entry, people }) => (
                <section key={entry.account_key} className="kf-pe-site kf-pe-site--panel is-active" aria-label={`Site: ${entry.name}`}>
                  <SiteHeadStatic entry={entry} />
                  <ul className="kf-pe-roster">
                    {people.map((p) => (
                      <PersonRow
                        key={p.worker_id}
                        p={p}
                        isSelf={false}
                        divider={false}
                        onOpen={openCard}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )
          ) : activePanel ? (
            <SitePanelView
              panel={activePanel}
              viewerWorkerId={viewerWorkerId}
              onOpen={openCard}
            />
          ) : (
            <section className="kf-pe-site">
              <div className="kf-pe-empty">
                <strong>No site selected</strong>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Phone stack: collapsible site sections. First site with
       * pending is expanded; the rest start collapsed. */}
      <div className="kf-pe-sitestack" aria-label="Sites (phone)">
        {Object.keys(panels).length > 0 ? (
          <>
            {Object.values(panels).map((panel) => (
              <PhoneSiteBlock
                key={panel.entry.account_key}
                panel={panel}
                defaultOpen={panel.entry.account_key === activeSiteKey}
                onOpen={openCard}
              />
            ))}
          </>
        ) : null}
      </div>

      {/* Docked "New" button (phone, inert). No navigation. */}
      <span
        className="kf-btn kf-btn--primary kf-pe-dock kf-only-phone kf-pe-disabled"
        aria-disabled="true"
        aria-label="New - coming with its own build step"
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
        <span>New</span>
      </span>
    </>
  );
}
