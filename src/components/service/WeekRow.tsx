// A week on the calendar.
//
// Shape:
//   Row 1: dates + optional chip                              [fold]
//   Row 2: meta line - meals + dollars + phase - state word   [fold]
//   Days grid (hidden when folded)
//
// The state word sits on row 2 to the right of the meta facts, never
// stacked on top of the dates on row 1. No ellipsis anywhere; narrow
// wide widths drop the phase to make room, and the phone's meta is
// one line that reads "N meals · State".
//
// Nothing in this row is a button in this train. The fold toggle on a
// foldable week IS a button.

"use client";

import { useState } from "react";
import { DayCell } from "./DayCell";
import { StatusWord } from "./StatusWord";
import { Icon } from "./Icon";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { WeekView } from "@/lib/sc/calendar/types";
import { shortDollarsFromCents } from "@/lib/sc/calendar/billable";
import { fmtDate, fmtCount } from "@/lib/fmt";

export function WeekRow({
  week, isCurrent, isBilled, foldableShort, foldablePhone, dayHrefs, reviewHref,
}: {
  week: WeekView;
  isCurrent: boolean;
  isBilled: boolean;
  foldableShort: boolean;
  foldablePhone: boolean;
  // Train 2: each day cell is a link to /service?...&day=ISO. Pre-
  // computed as a Record so no function crosses the server/client
  // boundary. An iso missing from the map means the cell stays
  // non-interactive.
  dayHrefs: Record<string, string>;
  // Train 3: the week's "Check and submit" link (or "See what was
  // submitted" when the week has a live finalize row). Null when the
  // week should not expose a review link (e.g. a week with no service).
  reviewHref: string | null;
}) {
  const [open, setOpen] = useState(false);
  const foldable = foldableShort || foldablePhone;

  const classes = ["kf-sc-wkrow", `st-${week.state}`];
  if (isCurrent) classes.push("is-now");
  if (foldableShort) classes.push("is-foldable-short");
  if (foldablePhone) classes.push("is-foldable-phone");
  if (foldable && open) classes.push("is-open");

  const datesLabel = `${fmtDate(week.dates[0], "short")} - ${fmtDate(week.dates[6], "short")}`;
  const mealsLabel = week.meals !== null
    ? `${fmtCount(week.meals)} ${week.meals === 1 ? "meal" : "meals"}`
    : "";
  const dollarsLabel = isBilled && week.billableCents !== null
    ? `${shortDollarsFromCents(week.billableCents)} before tax`
    : "";
  const phaseLabel = week.phase && (week.state === "to_enter" || week.state === "entered" || week.state === "still_open")
    ? week.phase
    : "";

  // Wide meta: meals + dollars + (phase only when >= 1280 wide; CSS
  // hides `.kf-sc-wkrow__phase` at narrower widths so the sub never
  // needs to ellipsize).
  const metaBits: { text: string; cls: string }[] = [];
  if (mealsLabel) metaBits.push({ text: mealsLabel, cls: "kf-sc-wkrow__sub-meals" });
  if (dollarsLabel) metaBits.push({ text: dollarsLabel, cls: "kf-sc-wkrow__sub-dollars" });
  if (phaseLabel) metaBits.push({ text: phaseLabel, cls: "kf-sc-wkrow__sub-phase" });

  // Phone short-form word (icon + "Submitted" vs "Submitted Fri, Nov 13").
  const phoneWord = week.state === "submitted" ? "Submitted" : week.word;

  return (
    <article className={classes.join(" ")} aria-label={`Week of ${datesLabel}`}>
      <div className="kf-sc-wkrow__line">
        {/* Row 1: dates + chip (fold spans both rows on the right). */}
        <h3 className="kf-sc-wkrow__dates">
          {datesLabel}
          {isCurrent ? <span className="kf-sc-chip kf-sc-chip--now">This week</span> : null}
        </h3>

        {/* Row 2: meta on the left (meals, dollars, phase), state word
         * on the right. No overlap because each lives in its own grid
         * cell and the row sits BELOW the dates. */}
        <div className="kf-sc-wkrow__meta">
          {metaBits.length > 0 ? (
            <p className="kf-sc-wkrow__sub kf-sc-only-wide">
              {metaBits.map((b, i) => (
                <span key={b.cls} className={b.cls}>
                  {i > 0 ? <span className="kf-sc-wkrow__sep" aria-hidden> · </span> : null}
                  {b.text}
                </span>
              ))}
            </p>
          ) : null}
          {/* Phone meta: "N meals · <icon> State" on one line. The
           * state's icon sits inline so the visual signal is preserved. */}
          {mealsLabel || phoneWord ? (
            <p className="kf-sc-wkrow__sub-phone kf-sc-only-narrow">
              {mealsLabel ? <span className="kf-sc-wkrow__sub-meals">{mealsLabel}</span> : null}
              {mealsLabel && phoneWord ? <span className="kf-sc-wkrow__sep" aria-hidden> · </span> : null}
              {phoneWord ? (
                <span className={`kf-sc-state kf-sc-state--${week.tone}`}>
                  <Icon name={week.icon} size={14} />
                  <span>{phoneWord}</span>
                </span>
              ) : null}
            </p>
          ) : null}
          {/* Wide state word on its own box, right-aligned. */}
          <div className="kf-sc-wkrow__state kf-sc-only-wide">
            <StatusWord tone={week.tone} icon={week.icon} word={week.word} />
          </div>
        </div>

        {foldable ? (
          <button
            type="button"
            className="kf-sc-wkrow__fold"
            aria-expanded={open}
            aria-label={open ? "Hide the days" : "Show the days"}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="kf-sc-wkrow__fold-text">{open ? "Hide the days" : "Show the days"}</span>
            {open ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
          </button>
        ) : null}
      </div>

      {/* Phone open-week summary line: dollars + phase, under the line. */}
      {(dollarsLabel || phaseLabel) ? (
        <p className="kf-sc-wkrow__phone-open-sub">
          {[dollarsLabel, phaseLabel].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      {/* Train 3: Check-and-submit link. On a submitted week the
       * same link reads "See what was submitted". Null when there
       * is no review to run (no service; not started yet). */}
      {reviewHref ? (
        <a href={reviewHref} className="kf-sc-wkrow__review">
          {week.state === "submitted" || week.state === "push_failed"
            ? "See what was submitted"
            : "Check and submit"}
        </a>
      ) : null}

      <ol className="kf-sc-wkrow__days" role="list">
        {week.days.map((d) => <DayCell key={d.iso} day={d} openHref={dayHrefs[d.iso] ?? null} />)}
      </ol>
    </article>
  );
}
