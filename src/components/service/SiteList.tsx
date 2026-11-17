// Stand-in site list for a viewer with more than one site in scope.
// Names + links grouped by region. A simpler shape will come in a
// later train when the Sites board is built.

import Link from "next/link";
import type { SiteNavItem } from "@/lib/sc/calendar/types";

export function SiteList({ sites, basePath }: { sites: SiteNavItem[]; basePath: string }) {
  const byRegion = new Map<string, SiteNavItem[]>();
  for (const s of sites) {
    const key = s.region ?? "No region";
    const arr = byRegion.get(key);
    if (arr) arr.push(s); else byRegion.set(key, [s]);
  }
  const regions = Array.from(byRegion.keys()).sort();

  return (
    <section className="kf-sc-sitelist" aria-label="Your sites">
      <header>
        <h2>Open a calendar</h2>
      </header>
      {regions.map((r) => (
        <div key={r} className="kf-sc-sitelist__region">
          <h3>{r}</h3>
          <ul>
            {byRegion.get(r)!.map((s) => (
              <li key={s.accountKey}>
                <Link className="kf-sc-sitelist__link" href={`${basePath}?site=${s.slug}`}>
                  <span>{s.name}</span>
                  <small>{s.accountKey}</small>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
