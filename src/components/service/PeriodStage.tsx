// The period on show: four week rows, a colour key sitting beside the
// day-of-week headers (which sit ONCE above the four rows), prev/next
// + "back to this period" links, and the "All four weeks submitted"
// badge when every week with service has been submitted.

import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays, Check } from "lucide-react";
import { WeekRow } from "./WeekRow";
import type { PeriodView } from "@/lib/sc/calendar/types";
import { fmtDate } from "@/lib/fmt";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function PeriodStage({
  period, isBilled, siteToday, hrefForPeriod, hrefForThisPeriod,
}: {
  period: PeriodView;
  isBilled: boolean;
  siteToday: string;
  hrefForPeriod: (periodNo: number) => string;
  hrefForThisPeriod: string;
}) {
  const todayIsInPeriod = siteToday >= period.startIso && siteToday <= period.endIso;
  const prevHref = period.periodNo > 1 ? hrefForPeriod(period.periodNo - 1) : null;
  const nextHref = period.periodNo < 13 ? hrefForPeriod(period.periodNo + 1) : null;

  const periodLabel = `Period ${period.periodNo}, ${fmtDate(period.startIso, "short")} to ${fmtDate(period.endIso, "short")}`;
  const closedNote = period.isClosed ? " · closed" : "";

  // "Folded above this week" on a short screen. We cannot know the
  // viewport height from the server, so every pre-current week that
  // has service and is submitted/closed is marked foldable; CSS gates
  // the fold to viewports 959px tall or less.
  const currentIdx = period.weeks.findIndex((w) => todayIsInPeriod && siteToday >= w.weekStart && siteToday <= w.dates[6]);

  return (
    <section className="kf-sc-stage" aria-label={periodLabel}>
      <header className="kf-sc-stage__head">
        <div className="kf-sc-stage__titles">
          <h2>Period {period.periodNo}{todayIsInPeriod ? <span className="kf-sc-chip kf-sc-chip--now">Now</span> : null}</h2>
          <p className="kf-sc-stage__meta">{fmtDate(period.startIso, "short")} to {fmtDate(period.endIso, "short")}{closedNote}</p>
          {period.allSubmitted ? (
            <p className="kf-sc-stage__done">
              <Check size={14} strokeWidth={1.75} aria-hidden /> All four weeks submitted
            </p>
          ) : null}
        </div>
        <nav className="kf-sc-stage__tools" aria-label="Period navigation">
          {!todayIsInPeriod ? (
            <Link href={hrefForThisPeriod} className="kf-btn kf-btn--ghost kf-sc-period-btn">
              <CalendarDays size={18} strokeWidth={1.5} aria-hidden /> This period
            </Link>
          ) : null}
          {prevHref ? (
            <Link href={prevHref} className="kf-sc-iconbtn" aria-label="Period before">
              <ChevronLeft size={20} strokeWidth={1.5} aria-hidden />
            </Link>
          ) : (
            <span className="kf-sc-iconbtn is-disabled" aria-hidden><ChevronLeft size={20} strokeWidth={1.5} /></span>
          )}
          {nextHref ? (
            <Link href={nextHref} className="kf-sc-iconbtn" aria-label="Period after">
              <ChevronRight size={20} strokeWidth={1.5} aria-hidden />
            </Link>
          ) : (
            <span className="kf-sc-iconbtn is-disabled" aria-hidden><ChevronRight size={20} strokeWidth={1.5} /></span>
          )}
        </nav>
      </header>

      {/* The dow row + the colour key sit beside each other on a wide
          screen: seven day headers above the four week rows, with the
          key under them. On a narrow screen these fold away (the
          per-week stacked layout labels each day itself). */}
      <div className="kf-sc-stage__dow kf-only-wide" aria-hidden>
        <div className="kf-sc-stage__dowgrid">
          {DOW.map((d) => <span key={d}>{d}</span>)}
        </div>
      </div>
      <Legend hasClosed={period.isClosed || period.weeks.some((w) => w.state === "period_closed")} />

      <ol className="kf-sc-stage__weeks" role="list">
        {period.weeks.map((w, i) => {
          const isCurrent = currentIdx === i;
          // "Finished weeks above this week" fold on a short screen.
          const foldable = currentIdx >= 0 && i < currentIdx && w.hasService &&
            (w.state === "submitted" || w.state === "push_failed" || w.state === "period_closed");
          return (
            <li key={w.weekStart}>
              <WeekRow
                week={w}
                isCurrent={isCurrent}
                isBilled={isBilled}
                foldable={foldable}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Legend({ hasClosed }: { hasClosed: boolean }) {
  const items: { key: string; word: string }[] = [
    { key: "sent",  word: "Submitted" },
    { key: "ent",   word: "Entered" },
    { key: "proj",  word: "Projected" },
    { key: "need",  word: "Needs actuals" },
    ...(hasClosed ? [{ key: "shut", word: "Closed" }] : []),
    { key: "none",  word: "No service" },
    { key: "today", word: "Today" },
  ];
  return (
    <ul className="kf-sc-legend" aria-label="Day colour key">
      {items.map((it) => (
        <li key={it.key}>
          <span className={`kf-sc-sq kf-sc-sq--key is-${it.key}`} aria-hidden />
          <span>{it.word}</span>
        </li>
      ))}
    </ul>
  );
}
