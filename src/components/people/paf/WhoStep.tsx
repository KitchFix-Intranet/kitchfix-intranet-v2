"use client";

// Who step. Search + You + One/Several switch + Your team by site.
// Reuses the SitePanel + RosterPerson shapes from loadTeam so the
// scope rules are not re-implemented. "Several people" is T4c; the
// switch renders with the Several option disabled.

import { useMemo, useState } from "react";
import { Search as SearchIcon, ChevronDown } from "lucide-react";
import type { RosterPerson, SelfRosterPerson, SiteNavEntry, SitePanel } from "@/lib/people/types";

type Props = {
  selfRow: SelfRosterPerson | null;
  sites: SiteNavEntry[];
  panels: Record<string, SitePanel>;
  defaultSiteKey: string;
  viewerWorkerId: string;
  singleSiteView: boolean;
  onPick: (person: { worker_id: string; display_name: string; account_key: string }) => void;
};

function RosterRow({
  p, onPick,
}: { p: RosterPerson; onPick: Props["onPick"] }) {
  return (
    <li>
      <button
        type="button"
        className="kf-pe-person"
        onClick={() => onPick({ worker_id: p.worker_id, display_name: p.display_name || "", account_key: p.account_key })}
        aria-label={`Pick ${p.display_name || "person"}`}
      >
        <span className="kf-pe-ava" aria-hidden>{p.initials}</span>
        <span className="kf-pe-person__who">
          <b>{p.display_name || "Unnamed"}</b>
          <small>{(p.title ?? "").trim() || "No role"}</small>
        </span>
      </button>
    </li>
  );
}

function SiteBlock({
  panel, defaultOpen, onPick,
}: { panel: SitePanel; defaultOpen: boolean; onPick: Props["onPick"] }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const sub = [panel.entry.city_state, panel.entry.level, `${panel.entry.count} ${panel.entry.count === 1 ? "person" : "people"}`]
    .filter(Boolean).join(" · ");
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
          <small>{sub}</small>
        </span>
        <ChevronDown size={18} strokeWidth={1.5} aria-hidden className="kf-pe-sitehead__chev" />
      </button>
      {expanded ? (
        <ul className="kf-pe-roster">
          {panel.people.map((p) => (
            <RosterRow key={p.worker_id} p={p} onPick={onPick} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function WhoStep({
  selfRow, sites, panels, defaultSiteKey, singleSiteView, onPick,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  // Flatten for search (same shape as My team's search).
  const allPeople = useMemo(() => {
    const out: Array<RosterPerson> = [];
    for (const key of Object.keys(panels)) {
      for (const p of panels[key].people) out.push(p);
    }
    return out;
  }, [panels]);

  const hits = useMemo(() => {
    if (!q) return [];
    return allPeople.filter((p) => {
      const hay = [p.display_name, p.title ?? "", p.account_key, p.account_region ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [allPeople, q]);

  // Phone stack: the sorted `sites` order (same fix as My team T3
  // Part 0 #1). For single-site viewers `sites` is empty; use the
  // one-entry panels map.
  const order = sites.length > 0 ? sites : Object.values(panels).map((p) => p.entry);

  return (
    <>
      <label className="kf-pe-field kf-pe-field--search kf-pe-search" aria-label="Find a person">
        <span className="kf-pe-search__ico" aria-hidden>
          <SearchIcon size={18} strokeWidth={1.5} />
        </span>
        <input
          type="search"
          placeholder="Find a person"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      {q ? (
        hits.length === 0 ? (
          <section className="kf-pe-site">
            <div className="kf-pe-empty">
              <strong>Nobody matches</strong>
              <span>Try a shorter search, or clear it.</span>
            </div>
          </section>
        ) : (
          <section className="kf-pe-site" aria-label="Search results">
            <ul className="kf-pe-roster">
              {hits.map((p) => <RosterRow key={p.worker_id} p={p} onPick={onPick} />)}
            </ul>
          </section>
        )
      ) : (
        <>
          {/* You card. */}
          {selfRow ? (
            <section className="kf-pe-site kf-pe-site--you" aria-label="You">
              <ul className="kf-pe-roster">
                <RosterRow p={selfRow} onPick={onPick} />
              </ul>
            </section>
          ) : null}

          {/* One / Several switch - Several is T4c, disabled here. */}
          <div className="kf-pe-seg kf-pe-multiseg" role="group" aria-label="How many people">
            <button type="button" aria-pressed="true">One person</button>
            <button type="button" aria-pressed="false" aria-disabled="true" className="kf-pe-disabled">
              Several people
            </button>
          </div>

          {/* Your team by site. Expanded iff only one site in scope,
             * or iff this site matches defaultSiteKey. */}
          <div className="kf-pe-sitestack">
            {order.map((entry) => {
              const panel = panels[entry.account_key];
              if (!panel) return null;
              const openByDefault = singleSiteView || entry.account_key === defaultSiteKey;
              return (
                <SiteBlock
                  key={entry.account_key}
                  panel={panel}
                  defaultOpen={openByDefault}
                  onPick={onPick}
                />
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
