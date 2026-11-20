// Big-league clubhouse calendar: monthly, read-only.
//
// One source: sc_homestand_schedule. The month arrows walk through
// the months the season loaded into. A sidebar lists the home stands
// that overlap this month. Season-over and empty-season states live
// in the Notice component at the top.

import Link from "next/link";
import { IdentBand } from "@/components/ui/IdentBand";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import type { MlbCalendarView, HomeStand } from "@/lib/sc/mlb/types";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW_LONG = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

export function BigLeagueCalendar({ view }: { view: MlbCalendarView }) {
  const headline = computeHeadline(view);

  return (
    <div className="kf-sc-surface">
      <IdentBand
        eyebrow={`${view.site.name}${view.site.region ? ` · ${view.site.region}` : ""}`}
        title={headline.title}
        kick={headline.kick}
      />

      <header className="kf-sc-phonehead kf-only-phone">
        <span className="kf-eyebrow kf-eyebrow--plain">{view.site.name}</span>
        <h1>{headline.title}</h1>
        <p>{headline.kick}</p>
      </header>

      <Notice view={view} />

      <div className="kf-sc-mlb-cols">
        <section className="kf-sc-card kf-sc-mlb-month" aria-label={view.month.monthLabel}>
          <div className="kf-sc-mlb-month__head">
            <div>
              <h3>{view.month.monthLabel}</h3>
              <p className="kf-sc-mlb-month__meta">
                {view.month.homeCountInMonth} home · {view.month.awayCountInMonth} away
              </p>
            </div>
            <div className="kf-sc-mlb-month__tools">
              {view.prevHref ? (
                <Link
                  href={view.prevHref}
                  className="kf-sc-iconbtn"
                  aria-label="Month before"
                >
                  <ChevronLeft size={20} strokeWidth={1.5} aria-hidden />
                </Link>
              ) : (
                <span className="kf-sc-iconbtn is-disabled" aria-hidden="true">
                  <ChevronLeft size={20} strokeWidth={1.5} />
                </span>
              )}
              {view.nextHref ? (
                <Link
                  href={view.nextHref}
                  className="kf-sc-iconbtn"
                  aria-label="Month after"
                >
                  <ChevronRight size={20} strokeWidth={1.5} aria-hidden />
                </Link>
              ) : (
                <span className="kf-sc-iconbtn is-disabled" aria-hidden="true">
                  <ChevronRight size={20} strokeWidth={1.5} />
                </span>
              )}
            </div>
          </div>

          <div
            className="kf-sc-mlb-grid"
            role="img"
            aria-label={`${view.month.monthLabel} games. The same games are listed in the sidebar.`}
          >
            {DOW.map((d, i) => (
              <div key={i} className="kf-sc-mlb-grid__dow">{d}</div>
            ))}
            {view.month.weeksCells.flat().map((cell) => (
              <div
                key={cell.iso}
                className={
                  "kf-sc-mlb-cell"
                  + (cell.isOutOfMonth ? " is-out" : "")
                  + (cell.isToday ? " is-today" : "")
                }
              >
                <span className="kf-sc-mlb-cell__n">
                  {cell.dayNum}
                  {cell.isToday ? <span className="kf-sc-mlb-cell__today"> · today</span> : null}
                </span>
                {cell.games.map((g, idx) => (
                  <span
                    key={idx}
                    className={`kf-sc-mlb-game kf-sc-mlb-game--${g.kind}`}
                  >
                    <b>
                      {g.kind === "away" ? "at " : "vs "}
                      {g.opponent}
                    </b>
                    <span>
                      {g.timeLabel ?? ""}
                      {g.kind === "exhibition" ? (g.timeLabel ? " · exhibition" : "exhibition") : ""}
                      {g.isDoubleheader ? (g.timeLabel || g.kind === "exhibition" ? " · doubleheader" : "doubleheader") : ""}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="kf-sc-card kf-sc-mlb-stands" aria-label={`Home stands in ${view.month.monthLabel}`}>
          <div className="kf-sc-mlb-stands__head">
            <h3>Home stands</h3>
            <p className="kf-sc-mlb-stands__meta">{view.month.monthLabel}</p>
          </div>
          {view.month.homeStands.length === 0 ? (
            <div className="kf-sc-mlb-stand">
              <p className="kf-sc-muted">No home stands in {view.month.monthLabel}.</p>
            </div>
          ) : (
            view.month.homeStands.map((s) => <StandCard key={standKey(s)} stand={s} />)
          )}
        </section>

        {/* Fix 2: phone agenda. Every game in the month in date
         * order so a phone reader sees what the desk grid shows. */}
        <section className="kf-sc-card kf-sc-mlb-agenda" aria-label={`${view.month.monthLabel} - every game in date order`}>
          <div className="kf-sc-mlb-stands__head">
            <h3>Every game</h3>
            <p className="kf-sc-mlb-stands__meta">{view.month.monthLabel}</p>
          </div>
          <PhoneAgenda view={view} />
        </section>
      </div>
    </div>
  );
}

function PhoneAgenda({ view }: { view: MlbCalendarView }) {
  // Walk the month's cells in date order and emit one line per game.
  const items: Array<{
    iso: string;
    dow: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    kind: "home" | "away" | "exhibition";
    opponent: string;
    timeLabel: string | null;
    isDoubleheader: boolean;
  }> = [];
  for (const row of view.month.weeksCells) {
    for (const cell of row) {
      if (cell.isOutOfMonth) continue;
      for (const g of cell.games) {
        const [, m, d] = cell.iso.split("-").map(Number);
        void m; void d;
        const dow = (((new Date(`${cell.iso}T12:00:00Z`).getUTCDay()) + 6) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
        items.push({
          iso: cell.iso,
          dow,
          kind: g.kind,
          opponent: g.opponent,
          timeLabel: g.timeLabel,
          isDoubleheader: g.isDoubleheader,
        });
      }
    }
  }
  if (items.length === 0) {
    return (
      <div className="kf-sc-mlb-agenda__empty">
        <p className="kf-sc-muted">No games in {view.month.monthLabel}.</p>
      </div>
    );
  }
  return (
    <ol className="kf-sc-mlb-agenda__list">
      {items.map((it, i) => {
        const [, m, d] = it.iso.split("-").map(Number);
        return (
          <li key={`${it.iso}-${i}`} className={`kf-sc-mlb-agenda__item is-${it.kind}`}>
            <span className="kf-sc-mlb-agenda__when">
              <b>{DOW_LONG[it.dow]}</b>
              <span>{MON_SHORT[m - 1]} {d}</span>
            </span>
            <span className="kf-sc-mlb-agenda__what">
              <b>{it.kind === "away" ? "at " : "vs "}{it.opponent}</b>
              <small>
                {it.timeLabel ?? (it.kind === "away" ? "" : "")}
                {it.kind === "exhibition" ? (it.timeLabel ? " · exhibition" : "exhibition") : ""}
                {it.isDoubleheader ? ((it.timeLabel || it.kind === "exhibition") ? " · doubleheader" : "doubleheader") : ""}
              </small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StandCard({ stand }: { stand: HomeStand }) {
  const span = sameMonthSpan(stand.startIso, stand.endIso);
  const n = stand.games.length;
  return (
    <div className="kf-sc-mlb-stand">
      <div className="kf-sc-mlb-stand__head">
        <b>Home {span}</b>
        <small>
          {n} {n === 1 ? "game" : "games"} · {stand.opponents.join(", ")}
        </small>
      </div>
      <ul>
        {stand.games.map((g) => {
          const [, m, d] = g.iso.split("-").map(Number);
          return (
            <li key={g.iso + g.opponent}>
              <span>{DOW_LONG[g.dow]} {MON_SHORT[m - 1]} {d}</span>
              <span>
                {g.opponent}
                {g.isExhibition ? " · exhibition" : ""}
                {g.isDoubleheader ? " · doubleheader" : ""}
              </span>
              <span>{g.timeLabel ?? ""}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Notice({ view }: { view: MlbCalendarView }) {
  // Season years are derived from the loaded span (train 5 carry-in).
  // When the schedule is empty we cannot name "this" season, so the
  // copy stays generic.
  const thisYear = view.lastGameIso
    ? Number(view.lastGameIso.slice(0, 4))
    : (view.firstGameIso ? Number(view.firstGameIso.slice(0, 4)) : null);
  const nextYear = thisYear != null ? thisYear + 1 : null;

  if (!view.firstGameIso) {
    return (
      <div className="kf-sc-mlb-notice">
        <span className="kf-sc-mlb-notice__icon" aria-hidden="true">
          <Calendar size={22} strokeWidth={1.5} />
        </span>
        <div>
          <div className="kf-sc-mlb-notice__title">No schedule loaded yet</div>
          <div className="kf-sc-mlb-notice__body">
            The {view.site.name} games will show here once the next schedule is in.
          </div>
        </div>
      </div>
    );
  }
  if (view.seasonOver && view.lastGameIso) {
    const [, m, d] = view.lastGameIso.split("-").map(Number);
    const last = `${MON_SHORT[m - 1]} ${d}`;
    return (
      <div className="kf-sc-mlb-notice">
        <span className="kf-sc-mlb-notice__icon" aria-hidden="true">
          <Calendar size={22} strokeWidth={1.5} />
        </span>
        <div>
          <div className="kf-sc-mlb-notice__title">The {thisYear} season is done</div>
          <div className="kf-sc-mlb-notice__body">
            Last game was {last}. The {nextYear} schedule will show here once it is loaded.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="kf-sc-mlb-notice">
      <span className="kf-sc-mlb-notice__icon" aria-hidden="true">
        <Calendar size={22} strokeWidth={1.5} />
      </span>
      <div>
        <div className="kf-sc-mlb-notice__title">Nothing for you to fill in</div>
        <div className="kf-sc-mlb-notice__body">
          This page only shows the calendar. Home games are the navy days.
        </div>
      </div>
    </div>
  );
}

function computeHeadline(view: MlbCalendarView): { title: string; kick: string } {
  const thisYear = view.lastGameIso
    ? Number(view.lastGameIso.slice(0, 4))
    : (view.firstGameIso ? Number(view.firstGameIso.slice(0, 4)) : null);
  const nextYear = thisYear != null ? thisYear + 1 : null;

  if (!view.firstGameIso) {
    return {
      title: "No schedule loaded yet",
      kick: "The next schedule will show here once it is loaded.",
    };
  }
  if (view.seasonOver && view.lastGameIso) {
    const [, m, d] = view.lastGameIso.split("-").map(Number);
    return {
      title: `The ${thisYear} season is done`,
      kick: `Last game was ${MON_SHORT[m - 1]} ${d} · ${view.seasonHomeGames} home games this season${nextYear ? ` · ${nextYear} schedule not loaded yet` : ""}`,
    };
  }
  // Mid-season.
  return {
    title: `${view.seasonHomeGames} home games this season`,
    kick: `${view.seasonHomeStands} home stands`,
  };
}

function sameMonthSpan(startIso: string, endIso: string): string {
  const [, sm, sd] = startIso.split("-").map(Number);
  const [, em, ed] = endIso.split("-").map(Number);
  if (sm === em && sd === ed) return `${MON_SHORT[sm - 1]} ${sd}`;
  if (sm === em) return `${MON_SHORT[sm - 1]} ${sd} - ${ed}`;
  return `${MON_SHORT[sm - 1]} ${sd} - ${MON_SHORT[em - 1]} ${ed}`;
}

function standKey(s: HomeStand): string {
  return s.homestandId ?? `${s.startIso}..${s.endIso}`;
}
