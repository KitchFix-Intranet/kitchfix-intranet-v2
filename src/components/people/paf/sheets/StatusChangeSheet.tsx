"use client";

// T4b-1 (2026-11-14). Part-time or full-time sheet. Title "Which
// way?". No conditionals.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import type { SheetFields, MissingSet } from "../sheetFields";

export function StatusChangeSheet({
  f, missing, onChange,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
}) {
  return (
    <>
      <Field label="Effective date" htmlFor="paf-eff" error={missing.effectiveDate ? "Needed" : null}>
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>

      <Field label="What is changing" error={missing.statusChangeDirection ? "Needed" : null}>
        <Switch2<string>
          options={[
            { value: "Part-time to full-time", label: "Part-time to full-time" },
            { value: "Full-time to part-time", label: "Full-time to part-time" },
          ]}
          value={f.statusChangeDirection || null}
          onChange={(v) => onChange({ statusChangeDirection: v })}
          ariaLabel="What is changing"
        />
      </Field>

      <Field label="Anything HR should know" htmlFor="paf-note" optional>
        <textarea
          id="paf-note"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="Shift details, coverage notes, anything that helps HR."
        />
      </Field>
    </>
  );
}
