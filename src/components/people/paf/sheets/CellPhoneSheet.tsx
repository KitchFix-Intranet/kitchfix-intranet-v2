"use client";

// T4b-1 (2026-11-14). Cell phone reimbursement sheet. Title "How
// much, and how often?". Amount + Frequency + Starts.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import { MoneyInput } from "../MoneyInput";
import type { SheetFields, MissingSet } from "../sheetFields";

export function CellPhoneSheet({
  f, missing, onChange,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
}) {
  return (
    <>
      <Field label="Amount" htmlFor="paf-amount" error={missing.amount ? "Needed" : null}>
        <MoneyInput
          id="paf-amount"
          value={f.amount}
          onChange={(v) => onChange({ amount: v })}
          ariaInvalid={missing.amount || undefined}
        />
      </Field>

      <Field label="Frequency" error={missing.cellFrequency ? "Needed" : null}>
        <Switch2<"Monthly" | "Bi-weekly">
          options={[{ value: "Monthly", label: "Monthly" }, { value: "Bi-weekly", label: "Bi-weekly" }]}
          value={f.cellFrequency || null}
          onChange={(v) => onChange({ cellFrequency: v })}
          ariaLabel="Frequency"
        />
      </Field>

      <Field
        label="Starts"
        htmlFor="paf-eff"
        hint="The pay period it lands in."
        error={missing.effectiveDate ? "Needed" : null}
      >
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>
    </>
  );
}
