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
  // Precompute every href as a plain string here on the server, so
  // nothing that crosses into a `"use client"` child is a function.
  // React's App Router rejects function props across the server/client
  // boundary unless they are marked `"use server"` (and these are not
  // server actions - they are URL builders).
  const periodHrefs: Record<number, string> = {};
  for (let p = 1; p <= 13; p++) {
    periodHrefs[p] = `${basePath}?site=${view.site.slug}&fy=${view.period.fiscalYear}&p=${p}${asQuery}`;
  }
  const thisPeriodHref = `${basePath}?site=${view.site.slug}${asQuery}`;
  const fyHrefs: Record<number, string> = {
    2026: `${basePath}?site=${view.site.slug}&fy=2026${asQuery}`,
    2027: `${basePath}?site=${view.site.slug}&fy=2027${asQuery}`,
  };
  const prevPeriodHref = view.period.periodNo > 1 ? periodHrefs[view.period.periodNo - 1] : null;
  const nextPeriodHref = view.period.periodNo < 13 ? periodHrefs[view.period.periodNo + 1] : null;
  const previewExitHref = thisPeriodHref.replace(/[&?]as=[^&]+/, "") || thisPeriodHref;

  // Per-day open link (train 2). iso -> `/service?...&day=iso`. Built
  // server-side so no function crosses into WeekRow (client).
  const dayHrefs: Record<string, string> = {};
  for (const w of view.period.weeks) {
    for (const iso of w.dates) {
      dayHrefs[iso] = `${basePath}?site=${view.site.slug}&fy=${view.period.fiscalYear}&p=${view.period.periodNo}${asQuery}&day=${iso}`;
    }
  }

  // Train 3: per-week review link. weekStart -> /service/review?site=&week=.
  // Show a link whenever the week has any service.
  const reviewHrefs: Record<string, string> = {};
  for (const w of view.period.weeks) {
    if (w.hasService) {
      reviewHrefs[w.weekStart] = `${basePath}/review?site=${view.site.slug}&week=${w.weekStart}`;
    }
  }

  // The band: the one thing the site needs first.
  const band = bandContent(view);

  return (
    <div className="kf-sc-surface">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref={previewExitHref} /> : null}

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
        prevPeriodHref={prevPeriodHref}
        nextPeriodHref={nextPeriodHref}
        thisPeriodHref={thisPeriodHref}
        dayHrefs={dayHrefs}
        reviewHrefs={reviewHrefs}
      />

      <YearSection
        fiscalYear={view.year.fiscalYear}
        cards={view.year.cards}
        totals={view.year.totals}
        periodHrefs={periodHrefs}
        fyHrefs={fyHrefs}
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
    // The band kick stays short (reads inside the IdentBand's 60-char
    // soft cap; at 1024 wide it still has to fit beside the facts). The
    // numbers live on the week row, not here.
    if (unentered > 0) {
      return {
        eyebrow,
        title: `${unentered} day${unentered === 1 ? "" : "s"} to enter this week`,
        kick: `Period ${view.period.periodNo}`,
      };
    }
    return {
      eyebrow,
      title: "This week is entered",
      kick: `Period ${view.period.periodNo}`,
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
