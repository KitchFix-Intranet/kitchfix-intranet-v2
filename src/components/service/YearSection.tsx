// Under the calendar: the whole year, 13 period cards.
//
// On a phone the whole section folds behind one line ("The year") so
// the landing stays about two screens.
//
// SERVER component. The phone-only fold lives in its own
// `"use client"` wrapper (YearFoldDisclosure) so we never cross a
// function into a client child.

import Link from "next/link";
import { Lock } from "lucide-react";
import { YearFoldDisclosure } from "./YearFoldDisclosure";
import type { YearPeriodCard, YearSquare } from "@/lib/sc/calendar/types";
import { fmtDate, fmtCount } from "@/lib/fmt";

export function YearSection({
  fiscalYear, cards, totals, periodHrefs, fyHrefs, isLoaded,
}: {
  fiscalYear: number;
  cards: YearPeriodCard[];
  totals: { entered: number; meals: number };
  // Precomputed strings: periodNo -> href, and fiscalYear -> href.
  // No functions cross the boundary; the phone fold wraps children.
  periodHrefs: Record<number, string>;
  fyHrefs: Record<number, string>;
  isLoaded: boolean;
}) {
  const sub = isLoaded
    ? `Fiscal ${fiscalYear} · ${fmtCount(totals.entered)} days entered · ${fmtCount(totals.meals)} meals`
    : `Fiscal ${fiscalYear}`;

  const body = isLoaded ? (
    <ol className="kf-sc-year" role="list">
      {cards.map((c) => (
        <li key={c.periodNo}>
          <YearCard card={c} href={periodHrefs[c.periodNo]} />
        </li>
      ))}
    </ol>
  ) : (
    <p className="kf-sc-yearsec__note">The {fiscalYear} calendar is not loaded yet.</p>
  );

  return (
    <section className="kf-sc-yearsec" aria-label="The year">
      <header className="kf-sc-yearsec__head">
        <div className="kf-sc-yearsec__titles">
          <h2>The year</h2>
          <p className="kf-sc-yearsec__meta">{sub}</p>
        </div>
        <nav className="kf-sc-seg" aria-label="Fiscal year">
          <Link className={fiscalYear === 2026 ? "is-on" : ""} href={fyHrefs[2026]} aria-current={fiscalYear === 2026 ? "true" : undefined}>2026</Link>
          <Link className={fiscalYear === 2027 ? "is-on" : ""} href={fyHrefs[2027]} aria-current={fiscalYear === 2027 ? "true" : undefined}>2027</Link>
        </nav>
      </header>

      <YearFoldDisclosure>{body}</YearFoldDisclosure>
    </section>
  );
}

const DOW_ONE = ["M", "T", "W", "T", "F", "S", "S"];

function YearCard({ card, href }: { card: YearPeriodCard; href: string }) {
  const classes = ["kf-sc-pcard"];
  if (card.isCurrent) classes.push("is-current");
  const foot = card.needsActualsCount > 0
    ? `${card.needsActualsCount} need${card.needsActualsCount === 1 ? "s" : ""} actuals`
    : card.meals > 0
      ? `${fmtCount(card.meals)} meals`
      : "No service";

  return (
    <Link className={classes.join(" ")} href={href} aria-current={card.isCurrent ? "true" : undefined}>
      <span className="kf-sc-pcard__head">
        <b>P{card.periodNo}</b>
        <span>{fmtDate(card.startIso, "short")} - {fmtDate(card.endIso, "short")}</span>
        {card.isCurrent ? <span className="kf-sc-chip kf-sc-chip--small">Now</span> : card.isClosed ? <Lock size={14} strokeWidth={1.5} aria-hidden /> : null}
      </span>
      <span className="kf-sc-pcard__dow" aria-hidden>
        {DOW_ONE.map((d, i) => <i key={i}>{d}</i>)}
      </span>
      <span className="kf-sc-pcard__grid" aria-hidden>
        {card.squares.map((s) => <YearSquareCell key={s.iso} square={s} />)}
      </span>
      <span className="kf-sc-pcard__foot">{foot}</span>
    </Link>
  );
}

function YearSquareCell({ square }: { square: YearSquare }) {
  const cls = `kf-sc-sq is-${sqTone(square.state)}`;
  const extra = `${square.isToday ? " is-today" : ""}${square.isHome ? " is-home" : ""}`;
  return (
    <span className={`${cls}${extra}`} />
  );
}

function sqTone(state: YearSquare["state"]): string {
  switch (state) {
    case "submitted": return "sent";
    case "closed": return "shut";
    case "entered":
    case "part_entered":
    case "not_served": return "ent";
    case "no_actuals": return "gap";
    case "needs_actuals":
    case "needs_fix": return "need";
    case "projected": return "proj";
    case "no_service": return "none";
  }
}
