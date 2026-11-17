// One row: the seven day cells under Mon to Sun, and a week column
// beside them (dates, meals + short dollars, where it stands).
// Nothing in this row is a button in this train. On a short screen a
// finished week folds to a line that opens on tap; that toggle is a
// button, and lives on the column.

"use client";

import { useState } from "react";
import { DayCell } from "./DayCell";
import { StatusWord } from "./StatusWord";
import { Icon } from "./Icon";
import type { WeekView } from "@/lib/sc/calendar/types";
import { shortDollarsFromCents } from "@/lib/sc/calendar/billable";
import { fmtDate, fmtCount } from "@/lib/fmt";

export function WeekRow({
  week, isCurrent, isBilled, foldable,
}: {
  week: WeekView;
  isCurrent: boolean;
  isBilled: boolean;
  // true: the week is a finished one that sits above the current week
  // on a short screen (<= 959px tall), so it starts folded.
  foldable: boolean;
}) {
  const [open, setOpen] = useState(false);

  const classes = ["kf-sc-wkrow", `st-${week.state}`];
  if (isCurrent) classes.push("is-now");
  if (foldable) classes.push("is-foldable");
  if (foldable && !open) classes.push("is-folded");

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

  return (
    <article className={classes.join(" ")} aria-label={`Week of ${datesLabel}`}>
      <ol className="kf-sc-wkrow__days" role="list">
        {week.days.map((d) => <DayCell key={d.iso} day={d} />)}
      </ol>
      <div className="kf-sc-wkrow__col">
        <div className="kf-sc-wkrow__dates">
          <h3>
            {datesLabel}
            {isCurrent ? <span className="kf-sc-chip kf-sc-chip--now">This week</span> : null}
          </h3>
        </div>
        {mealsLabel || dollarsLabel ? (
          <p className="kf-sc-wkrow__meals">
            {mealsLabel}{dollarsLabel ? <><span className="kf-sc-sep" aria-hidden> · </span>{dollarsLabel}</> : null}
          </p>
        ) : null}
        {phaseLabel ? <p className="kf-sc-wkrow__phase">{phaseLabel}</p> : null}
        <div className="kf-sc-wkrow__state">
          <StatusWord tone={week.tone} icon={week.icon} word={week.word} size={14} />
        </div>
        {foldable ? (
          <button
            type="button"
            className="kf-sc-wkrow__fold"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span>{open ? "Hide the days" : "Show the days"}</span>
            <Icon name={open ? "circle-dashed" : "circle-dashed"} size={14} />
          </button>
        ) : null}
      </div>
    </article>
  );
}
