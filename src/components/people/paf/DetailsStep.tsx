"use client";

// T4b-2 (2026-11-14). Details step dispatcher. Picks the right
// sheet for the chosen action. Shared chrome:
//   - person strip at the top (SheetAbout with title + club name),
//   - "Still needed: ..." summary at the top when missing fields
//     have been flagged (R-PP50).

import { SheetAbout } from "./SheetAbout";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { DatePicker } from "./DatePicker";
import { SeparationSheet } from "./sheets/SeparationSheet";
import { TitleChangeSheet } from "./sheets/TitleChangeSheet";
import { StatusChangeSheet } from "./sheets/StatusChangeSheet";
import { ReclassificationSheet } from "./sheets/ReclassificationSheet";
import { CellPhoneSheet } from "./sheets/CellPhoneSheet";
import { PayIncreaseSheet, type ClientBandSlice } from "./sheets/PayIncreaseSheet";
import { TravelReimbursementSheet } from "./sheets/TravelReimbursementSheet";
import { OtherReimbursementSheet } from "./sheets/OtherReimbursementSheet";
import { EquipmentRequestSheet } from "./sheets/EquipmentRequestSheet";
import type { PafAction } from "./WhatStep";
import type { SheetFields, MissingSet } from "./sheetFields";
import { missingSummary } from "./sheetFields";
import type { SelectOption } from "./Select";

function SimpleMoneySheet({
  action, f, missing, onChange,
}: {
  action: "add_bonus" | "add_deduction" | "add_gratuity";
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
}) {
  const whatForPlaceholder =
    action === "add_bonus" ? "One line is enough: 'Spring training coverage bonus'." :
    action === "add_deduction" ? "One line is enough: 'Reimburse the advance paid Nov 3'." :
    "One line is enough: 'Tips from Oct 25 service'.";
  const dateHint = action === "add_deduction"
    ? "The pay period it comes out of."
    : "The pay period it lands in.";
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
      <Field label="Effective date" htmlFor="paf-eff" hint={dateHint} error={missing.effectiveDate ? "Needed" : null}>
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>
      <Field label="What it is for" htmlFor="paf-expl" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-expl"
          rows={3}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder={whatForPlaceholder}
        />
      </Field>
    </>
  );
}

export function DetailsStep({
  action, person, fields, missing, onChange, accountOptions, bands, draftId, asWorkerId, isPreview,
}: {
  action: PafAction;
  person: { display_name: string; title?: string | null; site_name?: string | null } | null;
  fields: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
  accountOptions: readonly SelectOption[];
  bands: ClientBandSlice;
  draftId: string | null;
  asWorkerId: string | null;
  isPreview: boolean;
}) {
  const names = missingSummary(missing);
  return (
    <>
      {person ? <SheetAbout person={person} /> : null}

      {names.length > 0 ? (
        <div className="kf-pe-note kf-pe-note--warn" role="status">
          <b>Still needed</b> {names.length === 1
            ? names[0]
            : names.length === 2
              ? `${names[0]} and 1 more`
              : `${names[0]} and ${names.length - 1} more`}
        </div>
      ) : null}

      {action === "add_bonus" || action === "add_deduction" || action === "add_gratuity" ? (
        <SimpleMoneySheet action={action} f={fields} missing={missing} onChange={onChange} />
      ) : null}

      {action === "separation" ? (
        <SeparationSheet f={fields} missing={missing} onChange={onChange} />
      ) : null}

      {action === "title_change" ? (
        <TitleChangeSheet f={fields} missing={missing} onChange={onChange} />
      ) : null}

      {action === "status_change" ? (
        <StatusChangeSheet f={fields} missing={missing} onChange={onChange} />
      ) : null}

      {action === "reclassification" ? (
        <ReclassificationSheet f={fields} missing={missing} onChange={onChange} accountOptions={accountOptions} />
      ) : null}

      {action === "add_cell_phone" ? (
        <CellPhoneSheet f={fields} missing={missing} onChange={onChange} />
      ) : null}

      {action === "pay_increase" ? (
        <PayIncreaseSheet f={fields} missing={missing} onChange={onChange} bands={bands} />
      ) : null}

      {action === "travel_reimbursement" ? (
        <TravelReimbursementSheet
          f={fields} missing={missing} onChange={onChange}
          accountOptions={accountOptions}
          draftId={draftId} asWorkerId={asWorkerId} isPreview={isPreview}
        />
      ) : null}

      {action === "other_reimbursement" ? (
        <OtherReimbursementSheet
          f={fields} missing={missing} onChange={onChange}
          draftId={draftId} asWorkerId={asWorkerId} isPreview={isPreview}
        />
      ) : null}

      {action === "equipment_request" ? (
        <EquipmentRequestSheet f={fields} missing={missing} onChange={onChange} />
      ) : null}
    </>
  );
}
