"use client";

// T4b-1 (2026-11-14). Reclassification sheet. Title "Where are
// they moving?". Two dropdowns (From / To), two conditional
// blocks (title + rate), one reason.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Select } from "../Select";
import type { SelectOption } from "../Select";
import { Switch2 } from "../Switch2";
import { MoneyInput } from "../MoneyInput";
import type { SheetFields, MissingSet } from "../sheetFields";

export function ReclassificationSheet({
  f, missing, onChange, accountOptions,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
  accountOptions: readonly SelectOption[];
}) {
  return (
    <>
      <Field label="Effective date" htmlFor="paf-eff" error={missing.effectiveDate ? "Needed" : null}>
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>

      <div className="kf-pe-grid2">
        <Field label="From" htmlFor="paf-from" error={missing.reclassFrom ? "Needed" : null}>
          <Select
            id="paf-from"
            value={f.reclassFrom || null}
            options={accountOptions}
            onChange={(v) => onChange({ reclassFrom: v })}
            placeholder="Pick a site"
            ariaLabel="From"
          />
        </Field>
        <Field label="To" htmlFor="paf-to" error={missing.reclassTo ? "Needed" : null}>
          <Select
            id="paf-to"
            value={f.reclassTo || null}
            options={accountOptions}
            onChange={(v) => onChange({ reclassTo: v })}
            placeholder="Pick a site"
            ariaLabel="To"
            disabledValue={f.reclassFrom || null}
          />
        </Field>
      </div>

      <Field label="Will their title change?" error={missing.reclassTitleChange ? "Needed" : null}>
        <Switch2<"Yes" | "No">
          options={[{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }]}
          value={f.reclassTitleChange || null}
          onChange={(v) => onChange({ reclassTitleChange: v, ...(v === "No" ? { newTitle: "" } : {}) })}
          ariaLabel="Will their title change?"
        />
      </Field>

      {f.reclassTitleChange === "Yes" ? (
        <div className="kf-pe-grid2">
          <Field label="Current title" htmlFor="paf-old">
            <input
              id="paf-old"
              type="text"
              value={f.oldTitle}
              readOnly
              aria-readonly="true"
              placeholder="Set from the person's record"
            />
          </Field>
          <Field label="New title" htmlFor="paf-new" error={missing.newTitle ? "Needed" : null}>
            <input
              id="paf-new"
              type="text"
              value={f.newTitle}
              onChange={(e) => onChange({ newTitle: e.currentTarget.value })}
              placeholder="e.g. Lead Cook"
              autoComplete="off"
            />
          </Field>
        </div>
      ) : null}

      <Field label="Will their pay change?" error={missing.reclassChangeRate ? "Needed" : null}>
        <Switch2<"Yes" | "No">
          options={[{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }]}
          value={f.reclassChangeRate || null}
          onChange={(v) => onChange({ reclassChangeRate: v, ...(v === "No" ? { newRate: "" } : {}) })}
          ariaLabel="Will their pay change?"
        />
      </Field>

      {f.reclassChangeRate === "Yes" ? (
        <Field
          label="New rate"
          htmlFor="paf-rate"
          hint="Per hour for hourly people; annual salary for leadership."
          error={missing.newRate ? "Needed" : null}
        >
          <MoneyInput
            id="paf-rate"
            value={f.newRate}
            onChange={(v) => onChange({ newRate: v })}
            ariaInvalid={missing.newRate || undefined}
          />
        </Field>
      ) : null}

      <Field label="Reason for transfer" htmlFor="paf-why" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-why"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="Why they are moving, and anything the new team should know."
        />
      </Field>
    </>
  );
}
