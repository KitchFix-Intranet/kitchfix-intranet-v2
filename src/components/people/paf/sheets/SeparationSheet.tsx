"use client";

// T4b-1 (2026-11-14). Separation Details sheet. Title "When, and
// why?". Side column: "Who sees it" + the dates warning.
//
// Rules:
//   - Type (kf-pe-seg Voluntary/Involuntary); changing it CLEARS
//     Reason (Reason options depend on Type).
//   - "Check the dates" warning when Last day worked is after
//     Effective date. R-PP56: the warning does NOT show for
//     Furlough / Layoff / End of season (they often set the last
//     day deliberately later).
//   - Anything HR should know is optional.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import { PickOne } from "../PickOne";
import type { SheetFields, MissingSet } from "../sheetFields";

const VOL_REASONS = [
  { value: "Resignation",     label: "Resignation" },
  { value: "Job abandonment", label: "Job abandonment" },
] as const;
const INV_REASONS = [
  { value: "Termination",   label: "Termination" },
  { value: "Layoff",        label: "Layoff" },
  { value: "Furlough",      label: "Furlough" },
  { value: "End of season", label: "End of season" },
] as const;
const DATE_MISMATCH_QUIET: ReadonlySet<string> = new Set(["Furlough", "Layoff", "End of season"]);

function datesAreMisaligned(effective: string, lastDay: string): boolean {
  if (!effective || !lastDay) return false;
  // Both are YYYY-MM-DD; string compare works.
  return lastDay > effective;
}

export function SeparationSheet({
  f, missing, onChange,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
}) {
  const reasonOptions = f.actionGroup === "Voluntary" ? VOL_REASONS : INV_REASONS;
  const showDateWarning =
    f.actionGroup === "Involuntary" &&
    datesAreMisaligned(f.effectiveDate, f.lastDayWorked) &&
    !DATE_MISMATCH_QUIET.has(f.separationReason);

  return (
    <>
      <div className="kf-pe-grid2">
        <Field label="Effective date" htmlFor="paf-eff" error={missing.effectiveDate ? "Needed" : null}>
          <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
        </Field>
        <Field label="Last day worked" htmlFor="paf-last" error={missing.lastDayWorked ? "Needed" : null}>
          <DatePicker id="paf-last" value={f.lastDayWorked} onChange={(v) => onChange({ lastDayWorked: v })} />
        </Field>
      </div>

      {showDateWarning ? (
        <div className="kf-pe-note kf-pe-note--warn kf-pe-inline">
          <b>Check the dates</b> Last day worked is after the effective date. Usually the last day comes first. You can still send it.
        </div>
      ) : null}

      <Field label="Type" error={missing.actionGroup ? "Needed" : null}>
        <Switch2<"Voluntary" | "Involuntary">
          options={[{ value: "Voluntary", label: "Voluntary" }, { value: "Involuntary", label: "Involuntary" }]}
          value={f.actionGroup || null}
          onChange={(v) => onChange({ actionGroup: v, separationReason: "" })}
          ariaLabel="Type"
        />
      </Field>

      {f.actionGroup ? (
        <Field label="Reason" error={missing.separationReason ? "Needed" : null}>
          <PickOne
            options={reasonOptions}
            value={f.separationReason || null}
            onChange={(v) => onChange({ separationReason: v })}
            ariaLabel="Reason"
          />
        </Field>
      ) : null}

      <Field label="Eligible to rehire" error={missing.rehireEligible ? "Needed" : null}>
        <Switch2<"Yes" | "No">
          options={[{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }]}
          value={f.rehireEligible || null}
          onChange={(v) => onChange({ rehireEligible: v })}
          ariaLabel="Eligible to rehire"
        />
      </Field>

      <Field label="Anything HR should know" htmlFor="paf-note" optional>
        <textarea
          id="paf-note"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="Dates, conversations, anything that helps HR."
        />
      </Field>
    </>
  );
}
