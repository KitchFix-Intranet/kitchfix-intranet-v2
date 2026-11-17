// Under the calendar: the whole year, 13 period cards.
//
// On a phone the whole section folds behind one line ("The year") so
// the landing stays about two screens.

"use client";

import { useState } from "react";
import Link from "next/link";
import { Lock, ChevronDown, ChevronUp } from "lucide-react";
import type { YearPeriodCard, YearSquare } from "@/lib/sc/calendar/types";
import { fmtDate, fmtCount } from "@/lib/fmt";

export function YearSection({
  fiscalYear, cards, totals, hrefForPeriod, hrefForFy, isLoaded,
}: {
  fiscalYear: number;
  cards: YearPeriodCard[];
  totals: { entered: number; meals: number };
  hrefForPeriod: (periodNo: number) => string;
  hrefForFy: (fy: number) => string;
  isLoaded: boolean;
}) {
  const [open, setOpen] = useState(false);

  const sub = isLoaded
    ? `Fiscal ${fiscalYear} · ${fmtCount(totals.entered)} days entered · ${fmtCount(totals.meals)} meals`
    : `Fiscal ${fiscalYear}`;

  return (
    <section className="kf-sc-yearsec" aria-label="The year">
      <header className="kf-sc-yearsec__head">
        <div className="kf-sc-yearsec__titles">
          <h2>The year</h2>
          <p className="kf-sc-yearsec__meta">{sub}</p>
        </div>
        <nav className="kf-sc-seg" aria-label="Fiscal year">
          <Link className={fiscalYear === 2026 ? "is-on" : ""} href={hrefForFy(2026)} aria-current={fiscalYear === 2026 ? "true" : undefined}>2026</Link>
          <Link className={fiscalYear === 2027 ? "is-on" : ""} href={hrefForFy(2027)} aria-current={fiscalYear === 2027 ? "true" : undefined}>2027</Link>
        </nav>
      </header>

      {/* Phone-only fold toggle. On a wide screen the year shows in full. */}
      <button
        type="button"
        className="kf-sc-yearsec__fold kf-sc-only-narrow"
        aria-expanded={open}
        aria-controls="kf-sc-yearsec-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? "Hide the year" : "Show the year"}</span>
        {open ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
      </button>

      <div
        id="kf-sc-yearsec-body"
        className={`kf-sc-yearsec__body${open ? " is-open" : ""}`}
      >
        {isLoaded ? (
          <ol className="kf-sc-year" role="list">
            {cards.map((c) => (
              <li key={c.periodNo}>
                <YearCard card={c} href={hrefForPeriod(c.periodNo)} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="kf-sc-yearsec__note">The {fiscalYear} calendar is not loaded yet.</p>
        )}
      </div>
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
    <span className={`${cls}${extra}`}>
      {square.meals > 0 ? <b>{compactMeals(square.meals)}</b> : null}
    </span>
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

function compactMeals(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) {
    const k = n / 1000;
    const s = k.toFixed(1);
    return s.endsWith(".0") ? `${s.slice(0, -2)}k` : `${s}k`;
  }
  return String(n);
}
