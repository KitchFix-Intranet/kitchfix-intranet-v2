// The finish - plays when the week is locked and on record.
//
// Rule 9: this is the site's done, regardless of what the push does.
// No red: red means one thing in this system.

"use client";

import { useEffect, useState } from "react";
import { Check, CalendarDays } from "lucide-react";
import { fmtCount } from "@/lib/fmt";
import { finishOverlaySr } from "@/lib/sc/submit/finishOverlaySr";

const SIGN = "$";

interface Props {
  totalMeals: number;
  totalCents: number;
  submittedAt: string;
  isBilled: boolean;
  isBiweekly: boolean;
  unitStart: string;
  unitEnd: string;
  siteTimezone: string;
  onBackToCalendar: () => void;
}

export function FinishOverlay(props: Props) {
  // Count-up animation for meals. Respects prefers-reduced-motion.
  const [meals, setMeals] = useState(0);
  const [cents, setCents] = useState(0);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduced) { setMeals(props.totalMeals); setCents(props.totalCents); return; }
    const start = Date.now();
    const DUR = 900;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / DUR);
      const ease = 1 - Math.pow(1 - t, 3);
      setMeals(Math.round(props.totalMeals * ease));
      setCents(Math.round(props.totalCents * ease));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [props.totalMeals, props.totalCents, reduced]);

  const unitLabel = props.isBiweekly ? "Two weeks submitted" : "Week submitted";
  const subLine = props.isBilled
    ? `Submitted to accounting. On record and locked.`
    : `On record and locked. No invoice from this site.`;

  return (
    <div className="kf-sc-win" role="dialog" aria-modal="true" aria-labelledby="win-title">
      <div className="kf-sc-win__card">
        <svg className="kf-sc-win__check" viewBox="0 0 96 96" aria-hidden>
          <circle cx="48" cy="48" r="43" />
          <path d="M29 50l13 13 26-28" />
        </svg>
        <h2 id="win-title" className="kf-sc-win__title">{unitLabel}</h2>
        <p className="kf-sc-win__lead">{subLine}</p>
        <dl className="kf-sc-win__facts">
          <div><dt>Meals</dt><dd>{fmtCount(meals)}</dd></div>
          {props.isBilled && props.totalCents > 0 ? (
            <div><dt>Before tax</dt><dd>{SIGN}{(cents / 100).toFixed(2)}</dd></div>
          ) : null}
        </dl>
        <p className="kf-sc-win__set"><b>You are set.</b></p>
        <div className="kf-sc-win__acts">
          <button type="button" className="kf-btn kf-btn--primary" onClick={props.onBackToCalendar}>
            <CalendarDays size={18} strokeWidth={1.5} aria-hidden />
            <span>Back to the calendar</span>
          </button>
        </div>
        <span className="kf-sc-sr">
          <Check size={14} aria-hidden /> {finishOverlaySr({
            submittedAtIso: props.submittedAt,
            unitStartIso: props.unitStart,
            unitEndIso: props.unitEnd,
            timeZone: props.siteTimezone,
            isPair: props.isBiweekly,
          })}
        </span>
      </div>
    </div>
  );
}
