// The page shell: ident band on top, the period, the year. One
// server component. No interactivity in this train.

import { IdentBand } from "@/components/ui/IdentBand";
import { PeriodStage } from "./PeriodStage";
import { YearSection } from "./YearSection";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";
import type { CalendarView } from "@/lib/sc/calendar/types";
import { shortDollarsFromCents } from "@/lib/sc/calendar/billable";
import { fmtDate } from "@/lib/fmt";

export function CalendarPage({
  view,
  basePath,
  asQuery,
  previewName,
}: {
  view: CalendarView;
  basePath: string;
  asQuery: string;    // "" or "&as=<id>"
  previewName: string | null;
}) {
  const hrefForPeriod = (p: number) => `${basePath}?site=${view.site.slug}&fy=${view.period.fiscalYear}&p=${p}${asQuery}`;
  const hrefForThisPeriod = `${basePath}?site=${view.site.slug}${asQuery}`;
  const hrefForFy = (fy: number) => `${basePath}?site=${view.site.slug}&fy=${fy}${asQuery}`;

  // The band: the one thing the site needs first.
  const band = bandContent(view);

  return (
    <div className="kf-sc-surface">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref={hrefForThisPeriod.replace(/[&?]as=[^&]+/, "") || hrefForThisPeriod} /> : null}

      <IdentBand
        eyebrow={band.eyebrow}
        title={band.title}
        kick={band.kick}
      />

      {/* Phone head: the band is desktop-only; the heading becomes a
          real <h1> at the top of the page. No button here in this train. */}
      <header className="kf-sc-phonehead kf-only-phone">
        <span className="kf-eyebrow kf-eyebrow--plain">{band.eyebrow}</span>
        <h1>{band.title}</h1>
        {band.kick ? <p>{band.kick}</p> : null}
      </header>

      <PeriodStage
        period={view.period}
        isBilled={view.site.isBilled}
        siteToday={view.today}
        hrefForPeriod={hrefForPeriod}
        hrefForThisPeriod={hrefForThisPeriod}
      />

      <YearSection
        fiscalYear={view.year.fiscalYear}
        cards={view.year.cards}
        totals={view.year.totals}
        hrefForPeriod={hrefForPeriod}
        hrefForFy={hrefForFy}
        isLoaded={view.year.cards.length > 0}
      />
    </div>
  );
}

function bandContent(view: CalendarView): { eyebrow: string; title: string; kick: string } {
  const eyebrow = `${view.site.name}`;
  const cur = view.period.weeks.find((w) => view.today >= w.weekStart && view.today <= w.dates[6]);
  // Push-failed override, corp only.
  if (view.failedPushWeekStart && view.viewer.is_corp && !view.viewer.is_regional_director) {
    return {
      eyebrow,
      title: "The QuickBooks push did not land",
      kick: `Week of ${fmtDate(view.failedPushWeekStart, "short")} is submitted; the draft invoice is not in QuickBooks.`,
    };
  }
  // Still-open week before this one.
  const stillOpen = earliestStillOpen(view);
  if (stillOpen) {
    return {
      eyebrow,
      title: `The week of ${fmtDate(stillOpen.weekStart, "short")} is still open`,
      kick: `Period ${view.period.periodNo} · the numbers still need to be entered.`,
    };
  }
  if (cur) {
    // The headline for the current week.
    if (cur.state === "submitted") {
      return {
        eyebrow,
        title: "This week is submitted",
        kick: `Period ${view.period.periodNo}${cur.submittedAt ? ` · ${fmtDate(cur.submittedAt, "short")}` : ""}${!view.site.isBilled ? " · not billed through the calendar" : ""}`,
      };
    }
    if (cur.state === "not_serving") {
      return { eyebrow, title: "No service this week", kick: `Period ${view.period.periodNo}` };
    }
    const unentered = cur.days.filter((d) => d.state === "projected" || d.state === "needs_actuals" || d.state === "part_entered").length;
    if (unentered > 0) {
      return {
        eyebrow,
        title: `${unentered} day${unentered === 1 ? "" : "s"} to enter this week`,
        kick: cur.billableCents !== null
          ? `Period ${view.period.periodNo} · entered so far: ${cur.meals ?? 0} meals · ${shortDollarsFromCents(cur.billableCents)} before tax`
          : `Period ${view.period.periodNo} · entered so far: ${cur.meals ?? 0} meals`,
      };
    }
    return {
      eyebrow,
      title: "This week is entered",
      kick: `Period ${view.period.periodNo} · ${cur.meals ?? 0} meals${cur.billableCents !== null ? ` · ${shortDollarsFromCents(cur.billableCents)} before tax` : ""}`,
    };
  }
  // Viewing a period the site's today is not in.
  return {
    eyebrow,
    title: `Period ${view.period.periodNo}`,
    kick: `${fmtDate(view.period.startIso, "short")} - ${fmtDate(view.period.endIso, "short")}${view.period.isClosed ? " · closed" : ""}`,
  };
}

function earliestStillOpen(view: CalendarView) {
  for (const w of view.period.weeks) {
    if (w.state === "still_open") return w;
  }
  return null;
}
