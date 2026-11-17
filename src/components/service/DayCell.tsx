// One day on the calendar. Train 2: now a navigation link to
// /service?...&day=YYYY-MM-DD; the drawer opens on arrival (open-by-
// URL per rule 17 so Back closes it).
//
// The cell has two shapes driven by CSS:
//   - wide:   a stacked card, number as the big thing, state at the foot
//   - narrow: a 56px row, day+date | number | state, one line (home
//             game adds one more line below)

import Link from "next/link";
import { Icon } from "./Icon";
import { StatusWord } from "./StatusWord";
import type { DayView } from "@/lib/sc/calendar/types";
import { fmtDate } from "@/lib/fmt";

const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function DayCell({ day, openHref }: { day: DayView; openHref: string | null }) {
  const classes = ["kf-sc-cell", `is-${toneClass(day.state)}`];
  if (day.isToday) classes.push("is-today");
  if (day.home) classes.push("is-home");
  if (openHref) classes.push("is-link");

  const dateLong = fmtDate(day.iso, "long");
  const reading = buildReading(day, dateLong);

  const numberShown = day.meals !== null ? day.meals.toString()
    : day.projectedMeals !== null ? day.projectedMeals.toString()
    : "";
  const numberIsGhost = day.meals === null && day.projectedMeals !== null;
  const unitShown = numberShown
    ? (numberIsGhost ? "projected" : (day.meals === 1 ? "meal" : "meals"))
    : "";

  const inner = (
    <>
      <span className="kf-sc-sr">{reading}</span>

        {/* The dow + date line. "Today" sits inline when the cell is
         * wide enough, else wraps under the date. The ring on the cell
         * (kf-sc-cell.is-today outline) is the second signal. */}
        <span className="kf-sc-cell__when" aria-hidden>
          <b className="kf-sc-cell__dow">{DOW_SHORT[day.dow]}</b>
          <span className="kf-sc-cell__date">{fmtDate(day.iso, "short")}</span>
          {day.isToday ? <span className="kf-sc-cell__today">Today</span> : null}
        </span>

        {/* Number on its own line. The unit sits on the SAME line when
         * there is room, otherwise CSS drops it under the number. */}
        <span className="kf-sc-cell__fig" aria-hidden>
          {numberShown ? (
            <span className={`kf-sc-cell__num${numberIsGhost ? " is-ghost" : ""}`}>{numberShown}</span>
          ) : null}
          {unitShown ? <span className="kf-sc-cell__unit">{unitShown}</span> : null}
        </span>

        <span className="kf-sc-cell__st" aria-hidden>
          <StatusWord tone={day.tone} icon={day.icon} word={day.word} />
        </span>

        {day.home ? (
          <span className="kf-sc-cell__home" aria-hidden>
            <Icon name="house" size={14} />
            <span>{day.home.kind === "night" ? "Night game" : "Day game"}{day.home.time ? ` · ${day.home.time}` : ""}</span>
          </span>
        ) : null}
    </>
  );

  return (
    <li className={classes.join(" ")}>
      {openHref ? (
        <Link className="kf-sc-cell__link" href={openHref}>{inner}</Link>
      ) : (
        <div className="kf-sc-cell__inner">{inner}</div>
      )}
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
