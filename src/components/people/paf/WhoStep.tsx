"use client";

// T4a.1 (2026-11-14). Full rewrite to the render's classes:
//   - .kf-pe-field + .kf-pe-field--search + .kf-pe-search (single
//     border, icon inside the field at the left).
//   - .kf-pe-picklabel between the search and each list.
//   - .kf-pe-site + .kf-pe-picklist for the "You" row and the team.
//   - .kf-pe-pickgroup per site (collapsible), with .kf-pe-pickhead
//     carrying mark + title + sub + count + chev.
//
// Renders at every width; no kf-only-phone class. T4a put the team
// under .kf-pe-sitestack which is phone-only, so desktop viewers
// could only pick themselves.
//
// "Several people" is T4c; the switch renders with Several disabled.

import { useMemo, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
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

function PersonRow({
  p, onPick,
}: { p: RosterPerson; onPick: Props["onPick"] }) {
  const pick = () => onPick({
    worker_id: p.worker_id,
    display_name: p.display_name || "",
    account_key: p.account_key,
  });
  return (
    <li
      className="kf-pe-person"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }}
    >
      <span className="kf-pe-ava" aria-hidden>{p.initials}</span>
      <span className="kf-pe-person__who">
        <b>{p.display_name || "Unnamed"}</b>
        <small>{(p.title ?? "").trim() || "No role"}</small>
      </span>
      <span className="kf-pe-person__tags" />
      <span className="kf-pe-flight" />
      <svg
        className="kf-pe-person__chev"
        width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </li>
  );
}

function PickGroup({
  entry, panel, defaultOpen, onPick,
}: {
  entry: SiteNavEntry; panel: SitePanel;
  defaultOpen: boolean; onPick: Props["onPick"];
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`kf-pe-pickgroup${open ? "" : " is-collapsed"}`} data-site={entry.account_key}>
      <button
        type="button"
        className="kf-pe-pickhead"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kf-pe-mark" aria-hidden>{entry.mark}</span>
        <b>{entry.name}</b>
        <small>{entry.city || entry.city_state}</small>
        <span className="kf-pe-pickhead__n" data-count>{entry.count}</span>
        <svg
          className="kf-pe-sitehead__chev"
          width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <ul className="kf-pe-roster">
        {panel.people.map((p) => (
          <PersonRow key={p.worker_id} p={p} onPick={onPick} />
        ))}
      </ul>
    </div>
  );
}

export function WhoStep({
  selfRow, sites, panels, defaultSiteKey, singleSiteView, onPick,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const allPeople = useMemo(() => {
    const out: RosterPerson[] = [];
    for (const key of Object.keys(panels)) for (const p of panels[key].people) out.push(p);
    return out;
  }, [panels]);

  const hits = useMemo(() => {
    if (!q) return [];
    return allPeople.filter((p) => {
      const hay = [p.display_name, p.title ?? "", p.account_key, p.account_region ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [allPeople, q]);

  // Sorted desktop order (CORP first, then regions, then names).
  // Single-site viewers (SL + SM) get sites = []; fall back to the
  // one-entry panels map.
  const order = sites.length > 0 ? sites : Object.values(panels).map((p) => p.entry);

  const pickSelf = () => {
    if (!selfRow) return;
    onPick({
      worker_id: selfRow.worker_id,
      display_name: selfRow.display_name,
      account_key: selfRow.account_key,
    });
  };

  return (
    <>
      <label className="kf-pe-field kf-pe-field--search kf-pe-search kf-pe-search--inform" aria-label="Find a person, a role or a site">
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

      {q ? (
        hits.length === 0 ? (
          <section className="kf-pe-site kf-pe-picklist">
            <div className="kf-pe-empty">
              <strong>Nobody matches</strong>
              <span>Try a shorter search, or clear it.</span>
            </div>
          </section>
        ) : (
          <section className="kf-pe-site kf-pe-picklist" aria-label="Search results">
            <ul className="kf-pe-roster">
              {hits.map((p) => <PersonRow key={p.worker_id} p={p} onPick={onPick} />)}
            </ul>
          </section>
        )
      ) : (
        <>
          {/* You - a small eyebrow label + one row with the render's
           * subline. */}
          <span className="kf-eyebrow kf-eyebrow--plain kf-pe-picklabel">You</span>
          {selfRow ? (
            <section className="kf-pe-site kf-pe-picklist">
              <ul className="kf-pe-roster">
                <li
                  className="kf-pe-person kf-pe-person--you"
                  tabIndex={0}
                  onClick={pickSelf}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSelf(); } }}
                >
                  <span className="kf-pe-ava" aria-hidden>{selfRow.initials}</span>
                  <span className="kf-pe-person__who">
                    <b>{selfRow.display_name}</b>
                    <small>A reimbursement or a deduction for you</small>
                  </span>
                  <span className="kf-pe-person__tags" />
                  <span className="kf-pe-flight" />
                  <svg
                    className="kf-pe-person__chev"
                    width="18" height="18" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </li>
              </ul>
            </section>
          ) : null}

          {/* One / Several switch. Several is T4c. */}
          <div className="kf-pe-seg kf-pe-multiseg" role="group" aria-label="How many people">
            <button type="button" aria-pressed="true">One person</button>
            <button type="button" aria-pressed="false" aria-disabled="true" className="kf-pe-disabled">
              Several people
            </button>
          </div>

          {/* Your team, by site - visible at EVERY width. Sorted by
           * the same order the My team desktop nav uses. */}
          <span className="kf-eyebrow kf-eyebrow--plain kf-pe-picklabel">Your team, by site</span>
          <section className="kf-pe-site kf-pe-picklist">
            {order.map((entry) => {
              const panel = panels[entry.account_key];
              if (!panel) return null;
              const openByDefault = singleSiteView || entry.account_key === defaultSiteKey;
              return (
                <PickGroup
                  key={entry.account_key}
                  entry={entry}
                  panel={panel}
                  defaultOpen={openByDefault}
                  onPick={onPick}
                />
              );
            })}
          </section>
        </>
      )}
    </>
  );
}
