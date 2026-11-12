"use client";

// T4b-2 (2026-11-14). Travel reimbursement. Title "Which days were
// you away?". Site visited + date range + per-day per-diem choices
// + travel-supplement switch + business purpose + receipts.
//
// Server owns the TOTALS: the body's perDiemTotal /
// travelSupplementTotal / travelGrandTotal / per-tier counts are
// recomputed on every save in src/app/api/people/drafts/route.ts.
// We mirror the same arithmetic client-side so the viewer sees a
// running total while editing - but the SERVER value is what ends
// up stored and shown on Check.

import { useEffect, useMemo } from "react";
import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import { Select } from "../Select";
import type { SelectOption } from "../Select";
import type { SheetFields, MissingSet } from "../sheetFields";
import type { PerDiemDay } from "@/lib/people/perDiem";
import { PER_DIEM_TIERS, enumerateDays, tripDays } from "@/lib/people/perDiem";
import { ReceiptControl } from "../ReceiptControl";

const TIER_OPTS: readonly SelectOption[] = PER_DIEM_TIERS.map((t) => ({
  value: t.key,
  label: `${t.label} · $${t.rate}`,
}));

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function labelForDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return `${DOW[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function rateFor(key: string): number {
  return PER_DIEM_TIERS.find((t) => t.key === key)?.rate ?? 0;
}

export function TravelReimbursementSheet({
  f, missing, onChange, accountOptions, draftId, asWorkerId, isPreview,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
  accountOptions: readonly SelectOption[];
  draftId: string | null;
  asWorkerId: string | null;
  isPreview: boolean;
}) {
  const totalDays = tripDays(f.travelStartDate, f.travelEndDate);
  const tooLong = totalDays > 31;

  // Keep perDiemDays in sync with the start/end selection. Preserve
  // tier choices by date when the range shrinks/grows.
  useEffect(() => {
    if (!f.travelStartDate || !f.travelEndDate) {
      if (f.perDiemDays.length > 0) onChange({ perDiemDays: [] });
      return;
    }
    if (tooLong) return;
    const wanted = enumerateDays(f.travelStartDate, f.travelEndDate);
    const byDate = new Map(f.perDiemDays.map((d) => [d.date, d.tier]));
    const next: PerDiemDay[] = wanted.map((date) => ({ date, tier: byDate.get(date) ?? "" }));
    const same = next.length === f.perDiemDays.length
      && next.every((d, i) => d.date === f.perDiemDays[i].date && d.tier === f.perDiemDays[i].tier);
    if (!same) onChange({ perDiemDays: next });
  }, [f.travelStartDate, f.travelEndDate, tooLong, f.perDiemDays, onChange]);

  const perDiemTotal = useMemo(() => f.perDiemDays.reduce((sum, d) => sum + rateFor(d.tier), 0), [f.perDiemDays]);
  const supplementTotal = f.travelSupplementEnabled === "Yes" ? totalDays * 50 : 0;
  const grand = perDiemTotal + supplementTotal;

  const fullCount = f.perDiemDays.filter((d) => d.tier === "noMeals").length;
  const partialCount = f.perDiemDays.filter((d) => d.tier && d.tier !== "noMeals").length;
  const subText = f.perDiemDays.length === 0
    ? ""
    : `${f.perDiemDays.length} day${f.perDiemDays.length === 1 ? "" : "s"} · ${fullCount} full, ${partialCount} partial`;

  const updateDay = (date: string, tier: string) => {
    const next = f.perDiemDays.map((d) => d.date === date ? { ...d, tier } : d);
    onChange({ perDiemDays: next });
  };

  return (
    <>
      <Field label="Site visited" htmlFor="paf-site" error={missing.locationKey ? "Needed" : null}>
        <Select
          id="paf-site"
          value={f.locationKey || null}
          options={accountOptions}
          onChange={(v) => onChange({ locationKey: v })}
          placeholder="Pick a site"
          ariaLabel="Site visited"
        />
      </Field>

      <div className="kf-pe-grid2">
        <Field label="First day" htmlFor="paf-start" error={missing.travelStartDate ? "Needed" : null}>
          <DatePicker id="paf-start" value={f.travelStartDate} onChange={(v) => onChange({ travelStartDate: v })} />
        </Field>
        <Field label="Last day" htmlFor="paf-end" error={missing.travelEndDate ? "Needed" : null}>
          <DatePicker id="paf-end" value={f.travelEndDate} onChange={(v) => onChange({ travelEndDate: v })} />
        </Field>
      </div>

      {tooLong ? (
        <div className="kf-pe-note kf-pe-note--warn" role="status">
          <b>Too long</b> Trips over 31 days need to be split. Shorten the range.
        </div>
      ) : null}

      {f.perDiemDays.length > 0 && !tooLong ? (
        <>
          <Field label="Meals each day" hint="Pick what the site covered. The per diem fills in from the policy.">
            <ul className="kf-pe-days">
              {f.perDiemDays.map((d) => {
                const amt = rateFor(d.tier);
                return (
                  <li key={d.date} className="kf-pe-day">
                    <span className="kf-pe-day__date">{labelForDate(d.date)}</span>
                    <Select
                      value={d.tier || null}
                      options={TIER_OPTS}
                      onChange={(v) => updateDay(d.date, v)}
                      placeholder="Pick one"
                      ariaLabel={`Meals on ${labelForDate(d.date)}`}
                    />
                    <span className="kf-pe-day__amt">{amt ? `$${amt.toFixed(2)}` : ""}</span>
                  </li>
                );
              })}
              <li className="kf-pe-daytotal">
                <span>
                  <b>Per diem</b>
                  {subText ? <small>{subText}</small> : null}
                </span>
                <b>${perDiemTotal.toFixed(2)}</b>
              </li>
            </ul>
          </Field>

          <Field label="Travel supplement, $50 a day">
            <Switch2<"Yes" | "No">
              options={[{ value: "No", label: "No" }, { value: "Yes", label: "Yes" }]}
              value={f.travelSupplementEnabled || null}
              onChange={(v) => onChange({ travelSupplementEnabled: v })}
              ariaLabel="Travel supplement, $50 a day"
            />
          </Field>
          <small className="kf-pe-hint--up">Taxable. Only when the trip qualifies under the travel policy.</small>

          {f.travelSupplementEnabled === "Yes" ? (
            <div className="kf-pe-daytotal" style={{ marginBottom: "var(--sp-sp-4)" }}>
              <span>
                <b>Trip total</b>
                <small>Per diem + supplement</small>
              </span>
              <b>${grand.toFixed(2)}</b>
            </div>
          ) : null}
        </>
      ) : null}

      <Field label="Business purpose" htmlFor="paf-why" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-why"
          rows={2}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="Who you visited and why."
        />
      </Field>

      <ReceiptControl
        draftId={draftId}
        asWorkerId={asWorkerId}
        label="Add receipts"
        hint="Only for costs outside per diem."
        isPreview={isPreview}
      />
    </>
  );
}
