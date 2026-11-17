// One day on the calendar. Not a button this train, not focusable,
// not labelled by aria-label alone. The full reading sits in real
// text (visibly where the cell has room, visually hidden otherwise),
// inside an <li>, so a screen reader meets it in order.

import { Icon } from "./Icon";
import { StatusWord } from "./StatusWord";
import type { DayView } from "@/lib/sc/calendar/types";
import { fmtDate } from "@/lib/fmt";

const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function DayCell({ day }: { day: DayView }) {
  const classes = ["kf-sc-cell", `is-${toneClass(day.state)}`];
  if (day.isToday) classes.push("is-today");
  if (day.home) classes.push("is-home");

  const dateLong = fmtDate(day.iso, "long");
  // For the reading the screen reader picks up: a complete sentence,
  // in order, that explains everything on the cell.
  const reading = buildReading(day, dateLong);

  const numberShown = day.meals !== null ? day.meals.toString()
    : day.projectedMeals !== null ? day.projectedMeals.toString()
    : "";
  const numberIsGhost = day.meals === null && day.projectedMeals !== null;

  return (
    <li className={classes.join(" ")}>
      <div className="kf-sc-cell__inner">
        {/* The visually hidden full reading, in order. */}
        <span className="kf-sc-sr">{reading}</span>

        <span className="kf-sc-cell__mark" aria-hidden>
          <span className={`kf-sc-sq is-${toneClass(day.state)}${day.isToday ? " is-today" : ""}${day.home ? " is-home" : ""}`} />
        </span>

        <span className="kf-sc-cell__when" aria-hidden>
          <b className="kf-sc-cell__dow">{DOW_SHORT[day.dow]}</b>
          <span className="kf-sc-cell__date">{fmtDate(day.iso, "short")}</span>
          {day.isToday ? <i className="kf-sc-chip">Today</i> : null}
        </span>

        {day.home ? (
          <span className="kf-sc-cell__home" aria-hidden>
            <Icon name="house" size={14} />
            <span>{day.home.kind === "night" ? "Night game" : "Day game"}{day.home.time ? ` · ${day.home.time}` : ""}</span>
          </span>
        ) : null}

        <span className="kf-sc-cell__fig" aria-hidden>
          {numberShown ? (
            <>
              <span className={`kf-sc-cell__num${numberIsGhost ? " is-ghost" : ""}`}>{numberShown}</span>
              <span className="kf-sc-cell__unit">{numberIsGhost ? "projected" : (day.meals === 1 ? "meal" : "meals")}</span>
            </>
          ) : null}
        </span>

        <span className="kf-sc-cell__st" aria-hidden>
          <StatusWord tone={day.tone} icon={day.icon} word={day.word} size={14} />
        </span>
      </div>
    </li>
  );
}

function toneClass(state: DayView["state"]): string {
  switch (state) {
    case "submitted": return "sent";
    case "closed":    return "shut";
    case "entered":
    case "part_entered":
    case "not_served": return "ent";
    case "no_actuals": return "gap";
    case "needs_actuals":
    case "needs_fix":  return "need";
    case "projected":  return "proj";
    case "no_service": return "none";
  }
}

function buildReading(day: DayView, dateLong: string): string {
  const parts: string[] = [`${DOW_LONG[day.dow]} ${dateLong}`];
  if (day.isToday) parts.push("today");
  if (day.home) {
    parts.push(`${day.home.kind === "night" ? "Night" : "Day"} game${day.home.time ? ` at ${day.home.time}` : ""}`);
  }
  if (day.meals !== null) {
    parts.push(`${day.meals} ${day.meals === 1 ? "meal" : "meals"}`);
  } else if (day.projectedMeals !== null) {
    parts.push(`${day.projectedMeals} projected`);
  }
  parts.push(day.word);
  return parts.join(". ") + ".";
}
