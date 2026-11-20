// The week check screen (round 2).
//
// Jobs on this page (rules 5, 6, 8):
//   - A small table per day that has numbers (service, served, price,
//     before tax) under the day's heading (dow + date + totals).
//   - Rule 5: days the operator should look at (future, entered
//     ahead, or a line at 3x projection) show a "Looks right" tick.
//     Submit stays off until every called-out day is ticked.
//   - Rule 6: every day with numbers carries a quiet "Fix" button.
//     Pressing it flags the day on the server (DAY_FLAGGED then
//     holds the submit), opens the day form; saving the day clears
//     the flag.  Flagged days also surface a "No fix needed"
//     button that clears the flag without a navigate.
//   - Pinned summary with meals + before-tax dollars + one filled
//     Submit. Disabled while any preflight block is present or a
//     called-out day is unchecked; disabled copy names the first
//     blocker, using the day's name when it is a day fix.
//   - Nothing on this screen shows tax, totals-including-tax, or any
//     post-tax figure.

"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Flag, Send, RefreshCw, Lock, TriangleAlert, Check } from "lucide-react";
import { fmtCount } from "@/lib/fmt";
import type { ReviewView, ReviewDay, ReviewLine, ReviewLookReason } from "@/lib/sc/submit/reviewLoader";
import type { SubmitBlock } from "@/lib/sc/types";
import { FinishOverlay } from "./FinishOverlay";
import { ReopenPanel } from "./ReopenPanel";

const SIGN = "$";

interface Props {
  view: ReviewView;
  backHref: string;
  // Round 3: server-evaluated OUTBOUND_OFF, surfaced on load so the
  // person sees Submitting is not switched on yet BEFORE pressing.
  outboundBlock: { code: string; message: string } | null;
  // Train 4 carry-in 1: whether the signed-in viewer may press
  // "Push to QuickBooks again" on a V2 week that gave up.
  canPushAgain: boolean;
}

export function ReviewPage({ view, backHref, outboundBlock, canPushAgain }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [finish, setFinish] = useState<null | {
    totalMeals: number; totalCents: number; submittedAt: string; isBilled: boolean;
  }>(null);
  const [preflight, setPreflight] = useState<SubmitBlock[]>(view.preflight);
  const [netErr, setNetErr] = useState<string | null>(null);
  const [looked, setLooked] = useState<Record<string, boolean>>({});
  const [flagged, setFlagged] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {};
    for (const d of view.days) if (d.isFlagged) m[d.iso] = true;
    return m;
  });
  const [flagBusy, setFlagBusy] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState<"queued" | "refused" | "err" | null>(null);
  const [pushRefusedReason, setPushRefusedReason] = useState<string | null>(null);

  // Rule 5: every called-out day must be ticked before Submit lights.
  const unticked = useMemo(
    () => view.days.filter((d) => d.lookReasons.length > 0 && !looked[d.iso]),
    [view.days, looked],
  );
  // Rule 6: any day flagged here blocks submit (the server enforces
  // this too; the client preflight mirrors it so the button is right
  // before the POST round-trip).
  const flaggedDays = useMemo(
    () => view.days.filter((d) => flagged[d.iso]),
    [view.days, flagged],
  );

  const canSubmit =
    !view.isAlreadySubmitted
    && !busy
    && !outboundBlock
    && preflight.length === 0
    && unticked.length === 0
    && flaggedDays.length === 0;

  const blockerCopy = useMemo(
    () => (outboundBlock ? outboundBlock.message : firstBlockerCopy(preflight, flaggedDays, unticked)),
    [outboundBlock, preflight, flaggedDays, unticked],
  );

  // Rule 14: a not-billed account says so on this page too.
  const notBilledLede = !view.isBilled;

  // Rule 13: headline carries the before-tax number when billed.
  const headlineFact = view.isBilled && view.totalCents > 0
    ? `${SIGN}${fmtCents(view.totalCents)} before tax`
    : (view.totalMeals > 0 ? `${fmtCount(view.totalMeals)} ${pluralize("meal", view.totalMeals)}` : null);

  const onSubmit = useCallback(async () => {
    setBusy(true);
    setNetErr(null);
    try {
      const res = await fetch("/api/service/submit-week", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountKey: view.site.accountKey,
          // Round 2: post the Monday the page was opened with. For a
          // biweekly pair that is the CLOSING week's Monday - the key
          // the engine uses for the finalize row.
          weekStart: view.weekStart,
        }),
      });
      const payload = await res.json();
      if (!payload.ok) {
        if (payload.code === "BLOCKED" && Array.isArray(payload.blocks)) {
          setPreflight(payload.blocks as SubmitBlock[]);
        } else if (payload.code === "OUTBOUND_OFF") {
          setNetErr(typeof payload.message === "string" ? payload.message : "Submitting to accounting is not switched on yet.");
        } else {
          setNetErr(typeof payload.message === "string" ? payload.message : (payload.code ?? "That did not go through"));
        }
        return;
      }
      setFinish({
        totalMeals: payload.finish.totalMeals,
        totalCents: payload.finish.totalCents,
        submittedAt: payload.finish.submittedAt,
        isBilled: payload.finish.isBilled,
      });
    } catch (e) {
      setNetErr("That did not go through. Nothing was submitted and your numbers are safe.");
      void e;
    } finally {
      setBusy(false);
    }
  }, [view.site.accountKey, view.weekStart]);

  const onToggleLook = useCallback((iso: string) => {
    setLooked((prev) => ({ ...prev, [iso]: !prev[iso] }));
  }, []);

  const onFlagDay = useCallback(async (iso: string, dayHref: string) => {
    setFlagBusy(iso);
    try {
      const res = await fetch("/api/service/day-fix-flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountKey: view.site.accountKey, iso }),
      });
      const payload = await res.json();
      if (payload.ok) {
        setFlagged((prev) => ({ ...prev, [iso]: true }));
        router.push(dayHref);
      } else {
        setNetErr(typeof payload.message === "string" ? payload.message : "Could not mark the day. Try again.");
      }
    } catch {
      setNetErr("Could not mark the day. Nothing was changed.");
    } finally {
      setFlagBusy(null);
    }
  }, [view.site.accountKey, router]);

  const onPushAgain = useCallback(async () => {
    if (!view.finalizeRowId) return;
    setPushBusy(true);
    setPushResult(null);
    setPushRefusedReason(null);
    try {
      const res = await fetch("/api/service/push-again", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rowId: view.finalizeRowId }),
      });
      const payload = await res.json();
      if (payload.ok) {
        setPushResult("queued");
      } else if (payload.code === "REFUSED") {
        setPushResult("refused");
        setPushRefusedReason(typeof payload.reason === "string" ? payload.reason : null);
      } else {
        setPushResult("err");
        setNetErr(typeof payload.message === "string" ? payload.message : "The push did not queue. Try again.");
      }
    } catch {
      setPushResult("err");
      setNetErr("The push did not queue. Nothing was changed.");
    } finally {
      setPushBusy(false);
    }
  }, [view.finalizeRowId]);

  const onClearFlag = useCallback(async (iso: string) => {
    setFlagBusy(iso);
    try {
      const res = await fetch("/api/service/day-fix-flag", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountKey: view.site.accountKey, iso }),
      });
      const payload = await res.json();
      if (payload.ok) {
        setFlagged((prev) => { const n = { ...prev }; delete n[iso]; return n; });
      } else {
        setNetErr(typeof payload.message === "string" ? payload.message : "Could not clear the mark. Try again.");
      }
    } catch {
      setNetErr("Could not clear the mark. Nothing was changed.");
    } finally {
      setFlagBusy(null);
    }
  }, [view.site.accountKey]);

  return (
    <>
      <div className="kf-sc-rv-surface">
        <header className="kf-sc-rv-head">
          <Link href={backHref} className="kf-sc-rv-back">
            <ArrowLeft size={18} strokeWidth={1.5} aria-hidden /> Back to the calendar
          </Link>
          <h1>
            <span className="kf-sc-rv-head__eyebrow">{view.site.name}</span>
            <span className="kf-sc-rv-head__fact">
              {view.isBiweeklyUnit ? "Two weeks of " : "Week of "}
              {labelRange(view.unitStart, view.unitEnd)}
            </span>
            {headlineFact ? <span className="kf-sc-rv-head__num">{headlineFact}</span> : null}
          </h1>
          {notBilledLede ? (
            <p className="kf-sc-rv-head__note">Not billed through the service calendar.</p>
          ) : null}
        </header>

        {view.isAlreadySubmitted ? (
          <section className="kf-sc-rv-already" role="status">
            <Lock size={18} strokeWidth={1.5} aria-hidden />
            <span>Submitted and on record. Actuals are locked until the office reopens the week.</span>
          </section>
        ) : null}

        {view.isAlreadySubmitted && view.canReopen && view.submittedVia === "v2" ? (
          <ReopenPanel
            accountKey={view.site.accountKey}
            slug={view.site.slug}
            weekStart={view.weekStart}
            isBiweeklyUnit={view.isBiweeklyUnit}
          />
        ) : null}

        {view.pushGaveUp && view.submittedVia === "v2" ? (
          <section className="kf-sc-rv-pushfail" role="status" aria-label="QuickBooks push failed">
            <TriangleAlert size={18} strokeWidth={1.5} aria-hidden />
            <div className="kf-sc-rv-pushfail__body">
              <b>The QuickBooks push did not land.</b>
              <p>
                The week is submitted and on record. The draft invoice is not in QuickBooks yet.
              </p>
              {pushResult === "queued" ? (
                <p className="kf-sc-rv-pushfail__ok" role="status">The push is queued. Reload the page in a minute to see it land.</p>
              ) : null}
              {pushResult === "refused" ? (
                <p className="kf-sc-rv-pushfail__err" role="alert">
                  The push cannot run again from here
                  {pushRefusedReason ? ` (${pushRefusedReason.replace(/_/g, " ")})` : ""}.
                </p>
              ) : null}
            </div>
            {canPushAgain ? (
              <button
                type="button"
                className={`kf-btn kf-btn--primary${pushBusy ? " is-busy" : ""}`}
                onClick={onPushAgain}
                disabled={pushBusy || pushResult === "queued"}
              >
                {pushBusy ? <RefreshCw size={18} strokeWidth={1.5} aria-hidden /> : <Send size={18} strokeWidth={1.5} aria-hidden />}
                <span>{pushBusy ? "Queuing" : "Push to QuickBooks again"}</span>
              </button>
            ) : null}
          </section>
        ) : null}

        <ol className="kf-sc-rv-days" role="list">
          {view.days.map((d) => (
            <li key={d.iso}>
              <DayCard
                day={d}
                site={view.site}
                isBilled={view.isBilled}
                readOnly={view.isAlreadySubmitted}
                looked={!!looked[d.iso]}
                isFlaggedLocal={!!flagged[d.iso]}
                flagBusy={flagBusy === d.iso}
                onToggleLook={() => onToggleLook(d.iso)}
                onFlag={(href) => onFlagDay(d.iso, href)}
                onClearFlag={() => onClearFlag(d.iso)}
              />
            </li>
          ))}
        </ol>
      </div>

      <footer className={`kf-sc-rv-foot${view.isAlreadySubmitted ? " is-done" : ""}`} aria-label="Submit summary">
        <div className="kf-sc-rv-foot__totals">
          <span className="kf-sc-rv-foot__meals">
            <b>{fmtCount(view.totalMeals)}</b>
            <small>{pluralize("meal", view.totalMeals)}</small>
          </span>
          {view.isBilled && view.totalCents > 0 ? (
            <span className="kf-sc-rv-foot__cents">
              <b>{SIGN}{fmtCents(view.totalCents)}</b>
              <small>before tax</small>
            </span>
          ) : null}
          <span className="kf-sc-rv-foot__days">
            <b>{view.days.filter((d) => d.lines.length > 0).length}</b>
            <small>days</small>
          </span>
        </div>
        {!view.isAlreadySubmitted ? (
          <div className="kf-sc-rv-foot__acts">
            {!canSubmit && blockerCopy ? (
              <p className="kf-sc-rv-blocker" role="status">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden />
                <span>{blockerCopy}</span>
              </p>
            ) : null}
            <button
              type="button"
              className={`kf-btn kf-btn--primary${busy ? " is-busy" : ""}`}
              disabled={!canSubmit}
              onClick={onSubmit}
            >
              {busy ? <RefreshCw size={18} strokeWidth={1.5} aria-hidden /> : <Send size={18} strokeWidth={1.5} aria-hidden />}
              <span>{busy ? "Submitting" : (view.isBiweeklyUnit ? "Submit two weeks" : "Submit")}</span>
            </button>
            {netErr ? (
              <p className="kf-sc-rv-err" role="alert">
                <TriangleAlert size={16} strokeWidth={1.5} aria-hidden />
                <span>{netErr}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </footer>

      {finish ? (
        <FinishOverlay
          totalMeals={finish.totalMeals}
          totalCents={finish.totalCents}
          submittedAt={finish.submittedAt}
          isBilled={finish.isBilled}
          isBiweekly={view.isBiweeklyUnit}
          unitStart={view.unitStart}
          unitEnd={view.unitEnd}
          onBackToCalendar={() => router.replace(backHref)}
        />
      ) : null}
    </>
  );
}

interface DayCardProps {
  day: ReviewDay;
  site: ReviewView["site"];
  isBilled: boolean;
  readOnly: boolean;
  looked: boolean;
  isFlaggedLocal: boolean;
  flagBusy: boolean;
  onToggleLook: () => void;
  onFlag: (dayHref: string) => void;
  onClearFlag: () => void;
}

function DayCard({
  day, site, isBilled, readOnly, looked, isFlaggedLocal, flagBusy,
  onToggleLook, onFlag, onClearFlag,
}: DayCardProps) {
  const hasNumbers = day.lines.length > 0;
  const stateClass = `is-${day.stateCode}`;
  const grouped = useMemo(() => groupLines(day.lines), [day.lines]);
  const dayHref = `/service?site=${site.slug}&day=${day.iso}`;
  const needsLook = day.lookReasons.length > 0;

  return (
    <article className={`kf-sc-rv-card ${stateClass}${isFlaggedLocal ? " is-flagged" : ""}${needsLook && !looked ? " is-called-out" : ""}`}>
      <header className="kf-sc-rv-card__head">
        <h3>
          <b>{day.dowLong}, {day.dateLabel}</b>
          <span className={`kf-sc-chip kf-sc-chip--${toneFor(day.stateCode)}`}>{day.stateWord}</span>
        </h3>
        {hasNumbers ? (
          <p className="kf-sc-rv-card__tot">
            <span><b>{fmtCount(day.dayMeals)}</b> {pluralize("meal", day.dayMeals)}</span>
            {isBilled && day.dayCents != null ? <span>{SIGN}{fmtCents(day.dayCents)} before tax</span> : null}
          </p>
        ) : null}
      </header>

      {needsLook ? (
        <section className="kf-sc-rv-look" aria-label="Day marked for a look">
          <ul className="kf-sc-rv-look__list">
            {day.lookReasons.map((r, i) => <li key={i}>{lookReasonCopy(r)}</li>)}
          </ul>
          {!readOnly ? (
            <button
              type="button"
              className={`kf-btn kf-btn--line kf-sc-rv-look__btn${looked ? " is-on" : ""}`}
              onClick={onToggleLook}
              aria-pressed={looked}
            >
              <Check size={18} strokeWidth={1.5} aria-hidden /> Looks right
            </button>
          ) : null}
        </section>
      ) : null}

      {hasNumbers ? (
        <table className="kf-sc-rv-dl">
          <caption className="kf-sc-sr">Services served on {day.dowLong}</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col" className="kf-sc-rv-dl__q">Served</th>
              {isBilled ? <th scope="col" className="kf-sc-rv-dl__p">Price</th> : null}
              {isBilled ? <th scope="col" className="kf-sc-rv-dl__a">Before tax</th> : null}
            </tr>
          </thead>
          <tbody>
            {grouped.map(({ group, lines }) => (
              <RowGroup key={group ?? "__n"} group={group} lines={lines} isBilled={isBilled} />
            ))}
          </tbody>
        </table>
      ) : null}

      {day.notServedNames.length > 0 ? (
        <p className="kf-sc-rv-card__note">Not served: {day.notServedNames.join(", ")}.</p>
      ) : null}
      {day.blankProjectedNames.length > 0 ? (
        <p className="kf-sc-rv-card__note kf-sc-rv-card__note--warn">
          <Pencil size={14} strokeWidth={1.5} aria-hidden /> Left blank: {day.blankProjectedNames.join(", ")}.
        </p>
      ) : null}

      {!readOnly ? (
        <div className="kf-sc-rv-card__acts">
          {!hasNumbers && (day.stateCode === "projected" || day.stateCode === "part_entered") ? (
            <Link href={dayHref} className="kf-btn kf-btn--line" aria-label={`Enter ${day.dowLong}`}>
              <Pencil size={18} strokeWidth={1.5} aria-hidden /> {day.stateCode === "part_entered" ? "Finish" : "Enter"} {day.dowShort}
            </Link>
          ) : null}
          {hasNumbers && !isFlaggedLocal ? (
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={() => onFlag(dayHref)}
              disabled={flagBusy}
            >
              <Flag size={16} strokeWidth={1.5} aria-hidden /> Fix {day.dowShort}
            </button>
          ) : null}
          {isFlaggedLocal ? (
            <>
              <Link href={dayHref} className="kf-btn kf-btn--primary">
                <Flag size={18} strokeWidth={1.5} aria-hidden /> Fix it now
              </Link>
              <button
                type="button"
                className="kf-btn kf-btn--line"
                onClick={onClearFlag}
                disabled={flagBusy}
              >
                No fix needed
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function RowGroup({ group, lines, isBilled }: { group: string | null; lines: ReviewLine[]; isBilled: boolean }) {
  return (
    <>
      {group ? (
        <tr className="kf-sc-rv-dl__g"><th scope="colgroup" colSpan={isBilled ? 4 : 2}>{group}</th></tr>
      ) : null}
      {lines.map((ln) => (
        <tr key={ln.serviceId}>
          <th scope="row">{ln.serviceName}</th>
          <td className="kf-sc-rv-dl__q">{ln.isFlatFee ? "Yes" : fmtCount(ln.actualCount)}</td>
          {isBilled ? (
            <td className="kf-sc-rv-dl__p">
              {ln.isNonRevenue ? "" : (ln.priceCents == null ? "-" : `${SIGN}${fmtCents(ln.priceCents)} a ${unitSingular(ln.unit, ln.isFlatFee)}`)}
            </td>
          ) : null}
          {isBilled ? (
            <td className="kf-sc-rv-dl__a">
              {ln.isNotBilled ? "Not billed" : (ln.beforeTaxCents == null ? "-" : `${SIGN}${fmtCents(ln.beforeTaxCents)}`)}
            </td>
          ) : null}
        </tr>
      ))}
    </>
  );
}

function groupLines(lines: ReviewLine[]): { group: string | null; lines: ReviewLine[] }[] {
  const by = new Map<string | null, ReviewLine[]>();
  for (const l of lines) {
    const arr = by.get(l.groupName) ?? [];
    arr.push(l);
    by.set(l.groupName, arr);
  }
  return Array.from(by.entries()).map(([group, lines]) => ({ group, lines }));
}

function toneFor(state: string): string {
  switch (state) {
    case "entered":
    case "part_entered":
    case "not_served": return "info";
    case "submitted":  return "good";
    case "closed":
    case "projected":
    case "no_actuals":
    case "no_service":
    case "needs_actuals": return "muted";
    case "needs_fix":  return "warn";
    default: return "muted";
  }
}

function labelRange(startIso: string, endIso: string): string {
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [, sm, sd] = startIso.split("-").map(Number);
  const [, em, ed] = endIso.split("-").map(Number);
  return `${MON[sm - 1]} ${sd} - ${MON[em - 1]} ${ed}`;
}

function firstBlockerCopy(
  blocks: SubmitBlock[],
  flaggedDays: ReviewDay[],
  untickedDays: ReviewDay[],
): string | null {
  // Local flags come first so the day gets named with its weekday,
  // not "1 day marked for a fix".
  if (flaggedDays.length === 1) return `${flaggedDays[0].dowLong} needs a fix.`;
  if (flaggedDays.length > 1) {
    const names = flaggedDays.slice(0, 2).map((d) => d.dowLong).join(" and ");
    const rest = flaggedDays.length > 2 ? ` and ${flaggedDays.length - 2} more` : "";
    return `${names}${rest} need a fix.`;
  }
  if (untickedDays.length === 1) return `${untickedDays[0].dowLong} needs a look.`;
  if (untickedDays.length > 1) {
    const names = untickedDays.slice(0, 2).map((d) => d.dowLong).join(" and ");
    const rest = untickedDays.length > 2 ? ` and ${untickedDays.length - 2} more` : "";
    return `${names}${rest} need a look.`;
  }
  if (blocks.length === 0) return null;
  const b = blocks[0];
  switch (b.code) {
    case "NOT_AUTHORIZED":        return "You may not submit for this site.";
    case "ALREADY_SUBMITTED":     return "This week was already submitted.";
    case "WEEK_IN_FUTURE":        return "This week has not started yet. It can be submitted from its own Monday.";
    case "NOT_CLOSING_WEEK":      return "This is the first week of a two-week pair. Submit happens from the second week.";
    case "WEEK_LABEL_MISSING":    return "The two-week label is missing on this Monday. Ask the office to label it.";
    case "PERIOD_LOCKED":         return "The period is closed. Only the office can submit this week.";
    case "DAY_FLAGGED":           return `${b.detail.flaggedDates.length} day${b.detail.flaggedDates.length === 1 ? "" : "s"} marked for a fix.`;
    case "PROJECTION_UNENTERED":  return `${b.detail.lines.length} projected line${b.detail.lines.length === 1 ? "" : "s"} still need${b.detail.lines.length === 1 ? "s" : ""} a number.`;
    case "UNPRICED_LINES":        return `${b.detail.lines.length} line${b.detail.lines.length === 1 ? "" : "s"} have no price. The office sets it up before the week can be submitted.`;
  }
}

function lookReasonCopy(r: ReviewLookReason): string {
  switch (r.kind) {
    case "future":
      return `${r.dayWord} has not happened yet.`;
    case "entered_ahead":
      return `Entered ahead on ${r.onLabel}, not changed since.`;
    case "slipped":
      return `${r.serviceName}: ${fmtCount(r.actual)} is ${Math.round(r.actual / Math.max(1, r.projected))}x the ${fmtCount(r.projected)} projected.`;
  }
}

function fmtCents(cents: number): string {
  const dollars = cents / 100;
  const whole = Math.trunc(Math.abs(dollars));
  const fract = Math.abs(dollars) - whole;
  const sign = dollars < 0 ? "-" : "";
  const wholeStr = whole.toLocaleString("en-US");
  const fractStr = fract.toFixed(2).slice(2);  // "01", "12"
  return `${sign}${wholeStr}.${fractStr}`;
}

function pluralize(root: string, count: number): string {
  return count === 1 ? root : root + "s";
}

function unitSingular(unit: ReviewLine["unit"], isFlatFee: boolean): string {
  if (isFlatFee) return "week";
  switch (unit) {
    case "meals":   return "meal";
    case "each":    return "serving";
    case "pans":    return "pan";
    case "days":    return "day";
    case "dollars": return "dollar";
    default:        return "unit";
  }
}
