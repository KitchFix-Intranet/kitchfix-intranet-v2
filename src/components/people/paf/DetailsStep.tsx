"use client";

// T4a.1 (2026-11-14). Three sheets share the same shape, matching
// the render:
//   - person card at the top (same .kf-pe-about as What),
//   - Amount (money input with "$"),
//   - Effective date (custom date picker + per-action hint under),
//   - What it is for (textarea with the render's placeholder).
//
// All three required. R-PP50 shows the one-line summary at the top
// only when the viewer presses Check with something missing, and
// "Needed" on each missing field.

import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { DatePicker } from "./DatePicker";
import type { PafAction } from "./WhatStep";

type Missing = { amount: boolean; effectiveDate: boolean; explanation: boolean };

export function DetailsStep({
  action, person, amount, effectiveDate, explanation,
  missing, onChange,
}: {
  action: PafAction;
  person: { worker_id: string; display_name: string } | null;
  amount: string;
  effectiveDate: string;
  explanation: string;
  missing: Missing | null;
  onChange: (patch: { amount?: string; effectiveDate?: string; explanation?: string }) => void;
}) {
  // Render's placeholder per action.
  const whatForPlaceholder =
    action === "add_bonus" ? "One line is enough: 'Spring training coverage bonus'." :
    action === "add_deduction" ? "One line is enough: 'Reimburse the advance paid Nov 3'." :
    "One line is enough: 'Tips from Oct 25 service'.";

  // T4a.1 fix 18: the Effective date hint flips for deductions.
  // Bonus + gratuity add to a pay period; a deduction comes out of
  // a pay period.
  const dateHint = action === "add_deduction"
    ? "The pay period it comes out of."
    : "The pay period it lands in.";

  const missingNames: string[] = [];
  if (missing?.amount) missingNames.push("Amount");
  if (missing?.effectiveDate) missingNames.push("Effective date");
  if (missing?.explanation) missingNames.push("What it is for");

  return (
    <>
      {/* Person card on Details too, matching the render. */}
      {person ? (
        <div className="kf-pe-about">
          <span className="kf-pe-ava" aria-hidden>
            {(person.display_name || "?").split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
          </span>
          <span className="kf-pe-about__who">
            <b data-about="name">{person.display_name}</b>
          </span>
        </div>
      ) : null}

      {missingNames.length > 0 ? (
        <div className="kf-pe-note kf-pe-note--warn" role="status">
          <b>Still needed</b> {missingNames.join(", ")}
        </div>
      ) : null}

      <Field
        label="Amount"
        htmlFor="paf-amount"
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
        hint={dateHint}
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
