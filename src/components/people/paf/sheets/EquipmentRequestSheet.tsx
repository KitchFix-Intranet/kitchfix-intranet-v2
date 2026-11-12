"use client";

// T4b-2 (2026-11-14). Equipment or laptop request. Title "What do
// they need?". Request type switch (new/replacement), conditional
// replacement reason chips, conditional "reported" check for Lost
// or Stolen, conditional current-device textarea or "why" textarea,
// ship-to text, optional notes, conditional ship-back check.
//
// Boolean fields are stored as "true"/"false" strings so the record
// detail view reads them the same way after the row lands in
// `submissions` later.

import { Field } from "../Field";
import { Switch2 } from "../Switch2";
import { PickOne } from "../PickOne";
import type { SheetFields, MissingSet } from "../sheetFields";

const REASONS = [
  { value: "Damaged",               label: "Damaged" },
  { value: "Lost",                  label: "Lost" },
  { value: "Stolen",                label: "Stolen" },
  { value: "End of life / upgrade", label: "End of life / upgrade" },
] as const;

export function EquipmentRequestSheet({
  f, missing, onChange,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
}) {
  const isNew = f.equipmentRequestType === "new";
  const isRepl = f.equipmentRequestType === "replacement";
  const needReported = isRepl && (f.replacementReason === "Lost" || f.replacementReason === "Stolen");

  return (
    <>
      <Field label="Request" error={missing.equipmentRequestType ? "Needed" : null}>
        <Switch2<"new" | "replacement">
          options={[{ value: "new", label: "New device" }, { value: "replacement", label: "Replacement" }]}
          value={(f.equipmentRequestType || null) as "new" | "replacement" | null}
          onChange={(v) => onChange({
            equipmentRequestType: v,
            // Clear the other branch's fields so hidden state never
            // leaks into Check.
            ...(v === "new"
              ? { replacementReason: "", confirmReported: "", currentDeviceDetails: "", confirmReturn: "" }
              : { }),
          })}
          ariaLabel="Request"
        />
      </Field>

      {isRepl ? (
        <>
          <Field label="Reason for replacement" error={missing.replacementReason ? "Needed" : null}>
            <PickOne
              options={REASONS}
              value={f.replacementReason || null}
              onChange={(v) => onChange({
                replacementReason: v,
                // Reset the "reported" check if the reason no
                // longer needs it.
                ...(v === "Lost" || v === "Stolen" ? {} : { confirmReported: "" }),
              })}
              ariaLabel="Reason for replacement"
            />
          </Field>

          {needReported ? (
            <div className={`kf-pe-field${missing.confirmReported ? " is-missing" : ""}`}>
              <label className="kf-pe-check">
                <input
                  type="checkbox"
                  checked={f.confirmReported === "true"}
                  onChange={(e) => onChange({ confirmReported: e.currentTarget.checked ? "true" : "false" })}
                />
                <span className="kf-pe-check__box">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <span className="kf-pe-check__text">
                  <b>Reported to the Senior Director of Operations within 24 hours</b>
                  <small>Required for a lost or stolen device</small>
                </span>
              </label>
              {missing.confirmReported ? <span role="alert" className="kf-pe-field__err">Needed</span> : null}
            </div>
          ) : null}

          <Field label="Current device" htmlFor="paf-current" error={missing.currentDeviceDetails ? "Needed" : null}>
            <textarea
              id="paf-current"
              rows={2}
              value={f.currentDeviceDetails}
              onChange={(e) => onChange({ currentDeviceDetails: e.currentTarget.value })}
              placeholder="Make, model, and what is wrong."
            />
          </Field>
        </>
      ) : null}

      {isNew ? (
        <Field label="Why do they need a laptop?" htmlFor="paf-why" error={missing.explanation ? "Needed" : null}>
          <textarea
            id="paf-why"
            rows={2}
            value={f.explanation}
            onChange={(e) => onChange({ explanation: e.currentTarget.value })}
            placeholder="What they will use it for."
          />
        </Field>
      ) : null}

      <Field label="Ship the new device to" htmlFor="paf-shipto" error={missing.equipmentShipTo ? "Needed" : null}>
        <input
          id="paf-shipto"
          type="text"
          value={f.equipmentShipTo}
          onChange={(e) => onChange({ equipmentShipTo: e.currentTarget.value })}
          placeholder="Account site, home address, or other"
          autoComplete="off"
        />
      </Field>

      <Field label="Anything else" htmlFor="paf-notes" optional>
        <textarea
          id="paf-notes"
          rows={2}
          value={f.equipmentNotes}
          onChange={(e) => onChange({ equipmentNotes: e.currentTarget.value })}
          placeholder="Specs, urgency, context."
        />
      </Field>

      {isRepl ? (
        <div className={`kf-pe-field${missing.confirmReturn ? " is-missing" : ""}`}>
          <label className="kf-pe-check">
            <input
              type="checkbox"
              checked={f.confirmReturn === "true"}
              onChange={(e) => onChange({ confirmReturn: e.currentTarget.checked ? "true" : "false" })}
            />
            <span className="kf-pe-check__box">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span className="kf-pe-check__text">
              <b>I acknowledge the current device will be shipped back</b>
              <small>Required before sending</small>
            </span>
          </label>
          {missing.confirmReturn ? <span role="alert" className="kf-pe-field__err">Needed</span> : null}
        </div>
      ) : null}
    </>
  );
}
