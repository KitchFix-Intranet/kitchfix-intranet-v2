"use client";

// T4b-1 (2026-11-14). Change-in-title sheet. Title "What is the
// new role?". Conditional New rate when "Will their pay change
// too?" is Yes. The server owns the Current role field (from
// people.title) and overwrites the body's value on each save.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import { MoneyInput } from "../MoneyInput";
import type { SheetFields, MissingSet } from "../sheetFields";

export function TitleChangeSheet({
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

      <div className="kf-pe-grid2">
        {/* Current role is read-only, filled by the server from
         * people.title. The input is shown disabled so the viewer
         * can see what the system knows. */}
        <Field label="Current role" htmlFor="paf-old">
          <input
            id="paf-old"
            type="text"
            value={f.oldTitle}
            readOnly
            aria-readonly="true"
            placeholder="Set from the person's record"
          />
        </Field>
        <Field label="New role" htmlFor="paf-new" error={missing.newTitle ? "Needed" : null}>
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

      <Field label="Will their pay change too?" error={missing.reclassChangeRate ? "Needed" : null}>
        <Switch2<"Yes" | "No">
          options={[{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }]}
          value={f.reclassChangeRate || null}
          onChange={(v) => onChange({ reclassChangeRate: v, ...(v === "No" ? { newRate: "" } : {}) })}
          ariaLabel="Will their pay change too?"
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

      <Field label="Why" htmlFor="paf-why" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-why"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="e.g. Promotion, lateral move, restructuring"
        />
      </Field>
    </>
  );
}
