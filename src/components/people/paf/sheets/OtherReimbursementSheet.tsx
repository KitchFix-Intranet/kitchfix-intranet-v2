"use client";

// T4b-2 (2026-11-14). Other reimbursement sheet. Title "What did
// you pay for?". Amount + Date paid + What it was + one receipt.

import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { MoneyInput } from "../MoneyInput";
import type { SheetFields, MissingSet } from "../sheetFields";
import { ReceiptControl } from "../ReceiptControl";

export function OtherReimbursementSheet({
  f, missing, onChange, draftId, asWorkerId, isPreview,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
  draftId: string | null;
  asWorkerId: string | null;
  isPreview: boolean;
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

      <Field label="Date paid" htmlFor="paf-eff" error={missing.effectiveDate ? "Needed" : null}>
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>

      <Field label="What it was" htmlFor="paf-expl" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-expl"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="What, where, and why it was needed."
        />
      </Field>

      <ReceiptControl
        draftId={draftId}
        asWorkerId={asWorkerId}
        label="Add a receipt"
        hint="A photo or a PDF."
        isPreview={isPreview}
      />
    </>
  );
}
