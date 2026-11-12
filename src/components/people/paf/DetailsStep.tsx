"use client";

// Details step. Three sheets share the same shape:
//   Amount       (money input, > 0)
//   Effective date (custom date picker)
//   What it is for (textarea with render placeholder)
// All three are required. R-PP50: pressing Check with something
// missing shows one summary at the top and "Needed" on each
// missing field.

import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { DatePicker } from "./DatePicker";
import type { PafAction } from "./WhatStep";

type Missing = { amount: boolean; effectiveDate: boolean; explanation: boolean };

export function DetailsStep({
  action, amount, effectiveDate, explanation,
  missing, onChange,
}: {
  action: PafAction;
  amount: string;
  effectiveDate: string;
  explanation: string;
  missing: Missing | null;
  onChange: (patch: { amount?: string; effectiveDate?: string; explanation?: string }) => void;
}) {
  // Placeholder follows the render's wording per action.
  const whatForPlaceholder =
    action === "add_bonus" ? "What is the bonus for? Scope, team, shift..." :
    action === "add_deduction" ? "What is being paid back? Keep it short." :
    "Which shifts, what period, how it was divided.";

  // Summary at top (R-PP50). Count how many are missing and name
  // the first two for the human-readable sentence.
  const missingNames: string[] = [];
  if (missing?.amount) missingNames.push("Amount");
  if (missing?.effectiveDate) missingNames.push("Effective date");
  if (missing?.explanation) missingNames.push("What it is for");
  const summary = missingNames.length > 0
    ? (missingNames.length === 1
      ? `Still needed: ${missingNames[0]}`
      : missingNames.length === 2
        ? `Still needed: ${missingNames[0]} and 1 more`
        : `Still needed: ${missingNames[0]} and ${missingNames.length - 1} more`)
    : null;

  return (
    <>
      {summary ? (
        <div className="kf-pe-note kf-pe-note--warn" role="status">
          <b>Still needed</b> {missingNames.join(", ")}
        </div>
      ) : null}

      <Field
        label="Amount"
        htmlFor="paf-amount"
        hint="What the finance team will cut a cheque for."
        error={missing?.amount ? "Needed" : null}
      >
        <MoneyInput
          id="paf-amount"
          value={amount}
          onChange={(v) => onChange({ amount: v })}
          ariaInvalid={missing?.amount || undefined}
        />
      </Field>

      <Field
        label="Effective date"
        htmlFor="paf-date"
        hint="The pay period that includes this day picks it up."
        error={missing?.effectiveDate ? "Needed" : null}
      >
        <DatePicker
          id="paf-date"
          value={effectiveDate}
          onChange={(v) => onChange({ effectiveDate: v })}
          errorId={missing?.effectiveDate ? "paf-date-err" : undefined}
        />
      </Field>

      <Field
        label="What it is for"
        htmlFor="paf-explanation"
        hint="A sentence or two. Finance reads this."
        error={missing?.explanation ? "Needed" : null}
      >
        <textarea
          id="paf-explanation"
          rows={3}
          value={explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder={whatForPlaceholder}
        />
      </Field>
    </>
  );
}
