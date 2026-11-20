// Sites board - the office + regional directors' home page.
//
// One list, in order of who needs someone first, under four plain
// headings. The whole row is the button. Big league clubhouses sit
// in their own card below. A region filter shows for an office
// viewer with more than one region in scope.

import Link from "next/link";
import { IdentBand } from "@/components/ui/IdentBand";
import { fmtCount } from "@/lib/fmt";
import type { SitesBoardView, BoardRow, BigLeagueRow } from "@/lib/sc/sitesBoard/types";
import { DOW_LETTERS } from "@/lib/sc/sitesBoard/types";

export function SitesBoard({ view }: { view: SitesBoardView }) {
  return (
    <div className="kf-sc-surface">
      <IdentBand
        eyebrow={view.band.eyebrow}
        title={view.band.title}
        kick={view.band.kick}
      />

      <header className="kf-sc-phonehead kf-only-phone">
        <span className="kf-eyebrow kf-eyebrow--plain">{view.band.eyebrow}</span>
        <h1>{view.band.title}</h1>
        <p>{view.band.kick}</p>
      </header>

      <div className="kf-sc-sitesbar">
        <h2 className="kf-sc-sitesbar__wk">{view.weekLabel}</h2>
        {view.showRegionFilter ? (
          <div className="kf-sc-seg" role="group" aria-label="Region">
            <RegionBtn label="All"  value="all"  active={view.region} />
            <RegionBtn label="East" value="East" active={view.region} />
            <RegionBtn label="West" value="West" active={view.region} />
          </div>
        ) : null}
      </div>

      <section
        className="kf-sc-card kf-sc-sites"
        aria-label="Sites that enter and submit, in order of who needs someone first"
      >
        <div className="kf-sc-site kf-sc-site--head" aria-hidden="true">
          <span>Site</span>
          <span className="kf-sc-mini kf-sc-mini--dow">
            {DOW_LETTERS.map((x, i) => <i key={i}>{x}</i>)}
          </span>
          <span>Where it stands</span>
          <span />
          <span />
        </div>

        {view.buckets.map((b) => (
          <div key={b.key}>
            <div className={`kf-sc-region${b.key === "need" ? " is-need" : ""}`}>
              {b.label}<b>{b.rows.length === 1 ? "1 site" : `${b.rows.length} sites`}</b>
            </div>
            {b.rows.map((r) => <SiteRow key={r.site.accountKey} row={r} />)}
          </div>
        ))}

        {view.buckets.length === 0 ? (
          <div className="kf-sc-sites__empty">
            <p>No calendar sites in scope today.</p>
          </div>
        ) : null}
      </section>

      <ul className="kf-sc-legend kf-sc-legend--mini" aria-label="What the squares mean">
        <li><i className="kf-sc-sq kf-sc-sq--key is-sent" aria-hidden="true" />Submitted</li>
        <li><i className="kf-sc-sq kf-sc-sq--key is-ent"  aria-hidden="true" />Entered</li>
        <li><i className="kf-sc-sq kf-sc-sq--key is-proj" aria-hidden="true" />Projected</li>
        <li><i className="kf-sc-sq kf-sc-sq--key is-need" aria-hidden="true" />Needs actuals</li>
        <li><i className="kf-sc-sq kf-sc-sq--key is-none" aria-hidden="true" />No service</li>
      </ul>

      {view.bigLeague.length > 0 ? (
        <section
          className="kf-sc-card kf-sc-sites"
          aria-label="Big league clubhouses - calendar only"
        >
          <div className="kf-sc-region">
            Big league clubhouses<b>calendar only</b>
          </div>
          {view.bigLeague.map((r) => <BigLeagueSiteRow key={r.accountKey} row={r} />)}
        </section>
      ) : null}
    </div>
  );
}

function RegionBtn({ label, value, active }: {
  label: string;
  value: "all" | "East" | "West";
  active: "all" | "East" | "West";
}) {
  const href = value === "all" ? "/service" : `/service?region=${value}`;
  const pressed = active === value;
  return (
    <Link
      href={href}
      aria-pressed={pressed}
      className={pressed ? "is-on" : ""}
    >
      {label}
    </Link>
  );
}

function SiteRow({ row }: { row: BoardRow }) {
  const toneClass = `kf-sc-state--${row.tone}`;
  const meals = row.meals !== null
    ? `${fmtCount(row.meals)} ${row.meals === 1 ? "meal" : "meals"}${row.shortDollars ? ` · ${row.shortDollars}` : ""}`
    : null;
  return (
    <Link
      href={row.goHref}
      className="kf-sc-site"
      aria-label={`${row.site.name}: ${row.word}. ${row.goLabel}.`}
    >
      <span className="kf-sc-site__who">
        <SiteMark accountKey={row.site.accountKey} />
        <span className="kf-sc-site__name">
          <b>{row.site.name}</b>
          <small>
            {row.leaderName ?? "No site leader yet"}
          </small>
        </span>
      </span>
      <span className="kf-sc-site__week" aria-hidden="true">
        {/* DOW letters show only when the week card header is not
         * drawn above the row (phone). The desk header has them. */}
        <span className="kf-sc-mini kf-sc-mini--dow kf-sc-only-narrow">
          {row.squares.map((_, i) => <i key={i}>{"MTWTFSS"[i]}</i>)}
        </span>
        <span className="kf-sc-mini">
          {row.squares.map((sq) => (
            <span
              key={sq.iso}
              className={`kf-sc-sq kf-sc-sq--key is-${dotClass(sq.state)}${sq.isToday ? " is-today" : ""}${sq.isHome ? " is-home" : ""}`}
            />
          ))}
        </span>
      </span>
      <span className="kf-sc-site__status">
        <span className={`kf-sc-state ${toneClass}`}>{row.word}</span>
        {row.sub ? <small>{row.sub}</small> : null}
        {meals ? <small className="kf-sc-site__status-meals">{meals}</small> : null}
      </span>
      <span className="kf-sc-site__go">{row.goLabel}</span>
      <span className="kf-sc-site__chev" aria-hidden="true">›</span>
    </Link>
  );
}

function BigLeagueSiteRow({ row }: { row: BigLeagueRow }) {
  // Fix 4 (train 4b): one fact per phrase. Past-season sites read
  // "Last home game <date>"; in-season reads "in season". The date
  // is the last GAME row for the account.
  const seasonNote = row.seasonOver && row.lastHomeGameIso
    ? `Last home game ${shortDate(row.lastHomeGameIso)}`
    : "in season";
  return (
    <Link href={row.goHref} className="kf-sc-site kf-sc-site--big">
      <span className="kf-sc-site__who">
        <SiteMark accountKey={row.accountKey} />
        <span className="kf-sc-site__name">
          <b>{row.name}</b>
          <small>{row.leaderName ?? "Calendar only"}</small>
        </span>
      </span>
      <span className="kf-sc-site__week" aria-hidden="true" />
      <span className="kf-sc-site__status">
        <span className="kf-sc-state kf-sc-state--muted">Calendar only</span>
        <small>{seasonNote}</small>
      </span>
      <span className="kf-sc-site__go">
        <b>{row.homeGames}</b> home games
      </span>
      <span className="kf-sc-site__chev" aria-hidden="true">›</span>
    </Link>
  );
}

function SiteMark({ accountKey }: { accountKey: string }) {
  // "TBR - FL" -> "TBR" / "FL"; "TBJ - NY" -> "TBJ" / "NY".
  // A one-part key ("CORP") shows one line.
  const parts = accountKey.split(" - ");
  const top = parts[0];
  const bot = parts.length > 1 ? parts[parts.length - 1] : null;
  return (
    <span className="kf-sc-mark" aria-hidden="true">
      <span>{top}</span>
      {bot ? <span>{bot}</span> : null}
    </span>
  );
}

function dotClass(state: BoardRow["squares"][number]["state"]): string {
  switch (state) {
    case "submitted":    return "sent";
    case "closed":       return "shut";
    case "entered":
    case "part_entered":
    case "not_served":   return "ent";
    case "no_actuals":   return "gap";
    case "needs_actuals":
    case "needs_fix":    return "need";
    case "projected":    return "proj";
    case "no_service":   return "none";
  }
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${MON[m - 1]} ${d}`;
}
