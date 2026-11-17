// The period on show.
//
// Wide layout: four week rows under one row of day-of-week headers
// and a colour key. A finished week above this week folds to a line
// on a short screen (<= 959px tall); the server renders the fold
// toggle on foldable weeks, and CSS hides the toggle entirely on
// tall screens so nothing redundant appears.
//
// Narrow layout: this week is open as seven rows; every other week is
// a line that opens on tap. When the period on show does not hold
// today, the first week is the open one.

"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Check, ChevronDown, ChevronUp } from "lucide-react";
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

  const currentIdx = period.weeks.findIndex((w) => todayIsInPeriod && siteToday >= w.weekStart && siteToday <= w.dates[6]);
  // The "open week on a phone" when there is no current week: the
  // first week of the period on show.
  const phoneOpenIdx = currentIdx >= 0 ? currentIdx : 0;

  return (
    <section className="kf-sc-stage" aria-label={periodLabel}>
      {/* One-line period header: title + "This period" link + arrows. */}
      <header className="kf-sc-stage__head">
        <h2 className="kf-sc-stage__title">
          Period {period.periodNo}
          {todayIsInPeriod ? <span className="kf-sc-chip kf-sc-chip--now">Now</span> : null}
          <span className="kf-sc-stage__dates">{fmtDate(period.startIso, "short")} - {fmtDate(period.endIso, "short")}{closedNote}</span>
        </h2>
        <nav className="kf-sc-stage__tools" aria-label="Period navigation">
          {!todayIsInPeriod ? (
            <Link href={hrefForThisPeriod} className="kf-sc-period-btn">
              <Check size={16} strokeWidth={1.75} aria-hidden />
              <span>This period</span>
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

      {!isBilled ? (
        <p className="kf-sc-stage__note">Not billed through the service calendar.</p>
      ) : null}

      {period.allSubmitted ? (
        <p className="kf-sc-stage__done">
          <Check size={14} strokeWidth={1.75} aria-hidden /> All four weeks submitted
        </p>
      ) : null}

      {/* DOW row above the four weeks, wide-screen only. */}
      <div className="kf-sc-stage__dow kf-sc-only-wide" aria-hidden>
        {DOW.map((d) => <span key={d}>{d}</span>)}
      </div>

      <LegendFold hasClosed={period.isClosed || period.weeks.some((w) => w.state === "period_closed")} />

      <ol className="kf-sc-stage__weeks" role="list">
        {period.weeks.map((w, i) => {
          const isCurrent = currentIdx === i;
          // Short desk (wide, ≤ 959 tall): only a finished week ABOVE
          // this week folds. A future week stays open.
          const foldableShort = currentIdx >= 0 && i < currentIdx && w.hasService &&
            (w.state === "submitted" || w.state === "push_failed" || w.state === "period_closed");
          // Phone: every week except the open one folds (opens on tap).
          const foldablePhone = i !== phoneOpenIdx;
          return (
            <li key={w.weekStart}>
              <WeekRow
                week={w}
                isCurrent={isCurrent}
                isBilled={isBilled}
                foldableShort={foldableShort}
                foldablePhone={foldablePhone}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LegendFold({ hasClosed }: { hasClosed: boolean }) {
  const [open, setOpen] = useState(false);
  const items: { key: string; word: string }[] = [
    { key: "sent",  word: "Submitted" },
    { key: "ent",   word: "Entered" },
    { key: "proj",  word: "Projected" },
    { key: "need",  word: "Needs actuals" },
    ...(hasClosed ? [{ key: "shut", word: "Closed" }] : []),
    { key: "none",  word: "No service" },
    { key: "today", word: "Today" },
  ];
  // On a wide screen the key always sits in one line under the DOW.
  // On a phone the key folds behind "What the colours mean" so the
  // period header + colour key together take one line each.
  return (
    <>
      <ul className="kf-sc-legend kf-sc-only-wide" aria-label="Day colour key">
        {items.map((it) => (
          <li key={it.key}>
            <span className={`kf-sc-sq kf-sc-sq--key is-${it.key}`} aria-hidden />
            <span>{it.word}</span>
          </li>
        ))}
      </ul>
      <div className="kf-sc-legend-fold kf-sc-only-narrow">
        <button
          type="button"
          className="kf-sc-legend-fold__btn"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span>What the colours mean</span>
          {open ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
        </button>
        {open ? (
          <ul className="kf-sc-legend" aria-label="Day colour key">
            {items.map((it) => (
              <li key={it.key}>
                <span className={`kf-sc-sq kf-sc-sq--key is-${it.key}`} aria-hidden />
                <span>{it.word}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
