"use client";

// T4b-2 (2026-11-14). Pay increase recommendation. Title "How much,
// and why?". Fields:
//
//   - Effective date
//   - Increase type (chips: Merit, Market / structural, Promotion,
//                    Equity, Retention)
//   - Employee level (switch: Hourly / Leadership)
//   - Role (chips, keyed off level)
//   - Which role (text, when role === "Other")
//   - Current rate + Proposed rate (money, grid2)
//   - Pay band bar (hourly only, when band known for role+state)
//   - Eligibility (4 checkboxes)
//   - Why does this person deserve a raise? (textarea)
//
// The side column gets the mid-season note (effective date between
// Apr 1 and Sep 30) but that's assembled in PafFlow via the
// whoSeesIt / side-column flow. Here we just render the sheet body.

import { useMemo } from "react";
import { Field } from "../Field";
import { DatePicker } from "../DatePicker";
import { Switch2 } from "../Switch2";
import { PickOne } from "../PickOne";
import { MoneyInput } from "../MoneyInput";
import type { SheetFields, MissingSet } from "../sheetFields";
import type { Band } from "@/lib/people/payBands";

const INCREASE_TYPES = [
  { value: "Merit",               label: "Merit" },
  { value: "Market / structural", label: "Market / structural" },
  { value: "Promotion",           label: "Promotion" },
  { value: "Equity",              label: "Equity" },
  { value: "Retention",           label: "Retention" },
] as const;

const HOURLY_ROLE_OPTS = [
  { value: "Dishwasher",    label: "Dishwasher" },
  { value: "Cook",          label: "Cook" },
  { value: "FOH Attendant", label: "FOH Attendant" },
  { value: "Driver",        label: "Driver" },
  { value: "Other",         label: "Other" },
] as const;
const LEADERSHIP_ROLE_OPTS = [
  { value: "Sous Chef",           label: "Sous Chef" },
  { value: "Hospitality Manager", label: "Hospitality Manager" },
  { value: "Executive Chef",      label: "Executive Chef" },
  { value: "General Manager",     label: "General Manager" },
  { value: "Other",               label: "Other" },
] as const;

export interface ClientBandSlice {
  state: string | null;
  hourly: Record<string, Band>;
  leadership: Record<string, Band>;
}

function fmtRate(n: number, level: "hourly" | "leadership" | ""): string {
  if (level === "leadership") return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

export function PayIncreaseSheet({
  f, missing, onChange, bands,
}: {
  f: SheetFields;
  missing: MissingSet;
  onChange: (patch: Partial<SheetFields>) => void;
  bands: ClientBandSlice;
}) {
  const level = f.employeeLevel;
  const roleOpts = level === "leadership" ? LEADERSHIP_ROLE_OPTS : HOURLY_ROLE_OPTS;
  const showRole = level === "hourly" || level === "leadership";
  const showCustom = showRole && f.role === "Other";

  // Band resolution: hourly uses the state's role bands; leadership
  // is national.
  const band: Band | null = useMemo(() => {
    if (!f.role || f.role === "Other") return null;
    if (level === "hourly") return bands.hourly[f.role] ?? null;
    if (level === "leadership") return bands.leadership[f.role] ?? null;
    return null;
  }, [level, f.role, bands]);

  // Delta between old + new rate, for the band row.
  const delta = useMemo(() => {
    const o = Number(f.oldRate);
    const n = Number(f.newRate);
    if (!Number.isFinite(o) || !Number.isFinite(n) || o <= 0) return null;
    const d = n - o;
    const pct = (d / o) * 100;
    return { d, pct };
  }, [f.oldRate, f.newRate]);

  // Position within band - returns percent and in-band/out messages.
  const bandPos = useMemo(() => {
    if (!band) return null;
    const n = Number(f.newRate);
    if (!Number.isFinite(n) || n <= 0) return null;
    const pctOfRange = ((n - band.min) / (band.max - band.min)) * 100;
    const clamped = Math.max(0, Math.min(100, pctOfRange));
    let msg: string;
    if (n < band.min) msg = `${fmtRate(n, level)} is below band`;
    else if (n > band.max) msg = `${fmtRate(n, level)} is above band`;
    else msg = `${fmtRate(n, level)} is within band, ${Math.round(clamped)}% of range`;
    return { pct: clamped, inBand: n >= band.min && n <= band.max, msg };
  }, [band, f.newRate, level]);

  // Eligibility counter (x of 4). Boolean state is stored as "true"/"false".
  const eligChecks: Array<{
    key: keyof SheetFields;
    label: string; sub?: string;
  }> = [
    { key: "eligSeasonComplete", label: "Completed at least one full season or review period" },
    { key: "eligNoDiscipline",   label: "Not on an active disciplinary track", sub: "No Level 3, final written warning or PIP under SOP-004" },
    { key: "eligCertsCurrent",   label: "Required certifications current", sub: "ServSafe Food Handler and ServSafe Allergen" },
    { key: "eligManagerApproved",label: "Discussed and approved by your manager" },
  ];
  const checkedCount = eligChecks.reduce((n, c) => n + (f[c.key] === "true" ? 1 : 0), 0);
  const allChecked = checkedCount === eligChecks.length;

  const setElig = (k: keyof SheetFields, checked: boolean) =>
    onChange({ [k]: checked ? "true" : "false" } as Partial<SheetFields>);

  return (
    <>
      <Field label="Effective date" htmlFor="paf-eff" error={missing.effectiveDate ? "Needed" : null}>
        <DatePicker id="paf-eff" value={f.effectiveDate} onChange={(v) => onChange({ effectiveDate: v })} />
      </Field>

      <Field label="Increase type" error={missing.increaseType ? "Needed" : null}>
        <PickOne
          options={INCREASE_TYPES}
          value={f.increaseType || null}
          onChange={(v) => onChange({ increaseType: v })}
          ariaLabel="Increase type"
        />
      </Field>

      <Field label="Employee level" error={missing.employeeLevel ? "Needed" : null}>
        <Switch2<"hourly" | "leadership">
          options={[{ value: "hourly", label: "Hourly" }, { value: "leadership", label: "Leadership" }]}
          value={(f.employeeLevel || null) as "hourly" | "leadership" | null}
          onChange={(v) => onChange({ employeeLevel: v, role: "", customRole: "" })}
          ariaLabel="Employee level"
        />
      </Field>

      {showRole ? (
        <Field label="Role" error={missing.role ? "Needed" : null}>
          <PickOne
            options={roleOpts}
            value={f.role || null}
            onChange={(v) => onChange({ role: v, ...(v !== "Other" ? { customRole: "" } : {}) })}
            ariaLabel="Role"
          />
        </Field>
      ) : null}

      {showCustom ? (
        <Field label="Which role" htmlFor="paf-customrole" error={missing.customRole ? "Needed" : null}>
          <input
            id="paf-customrole"
            type="text"
            value={f.customRole}
            onChange={(e) => onChange({ customRole: e.currentTarget.value })}
            placeholder="Type the role"
            autoComplete="off"
          />
        </Field>
      ) : null}

      <div className="kf-pe-grid2">
        <Field
          label="Current rate"
          htmlFor="paf-oldrate"
          hint="Hourly rate, or annual salary for leadership."
          error={missing.oldRate ? "Needed" : null}
        >
          <MoneyInput
            id="paf-oldrate"
            value={f.oldRate}
            onChange={(v) => onChange({ oldRate: v })}
            ariaInvalid={missing.oldRate || undefined}
          />
        </Field>
        <Field label="Proposed rate" htmlFor="paf-newrate" error={missing.newRate ? "Needed" : null}>
          <MoneyInput
            id="paf-newrate"
            value={f.newRate}
            onChange={(v) => onChange({ newRate: v })}
            ariaInvalid={missing.newRate || undefined}
          />
        </Field>
      </div>

      {band && delta ? (
        <div className="kf-pe-band">
          <div className={`kf-pe-band__row${bandPos && !bandPos.inBand ? " kf-pe-band__row--out" : ""}`}>
            <span>
              Band · {f.role}{level === "hourly" && bands.state ? ` · ${bands.state}` : ""}
            </span>
            <b>
              {delta.d >= 0 ? "+" : ""}{fmtRate(delta.d, level)} · {delta.pct.toFixed(1)}%
            </b>
          </div>
          {bandPos ? (
            <div className="kf-pe-band__bar">
              <i style={{ left: `${bandPos.pct}%` }} />
            </div>
          ) : null}
          <div className="kf-pe-band__ends">
            <span>{fmtRate(band.min, level)}</span>
            <span>{bandPos ? bandPos.msg : null}</span>
            <span>{fmtRate(band.max, level)}</span>
          </div>
        </div>
      ) : null}

      <div className={`kf-pe-field kf-pe-field--elig${missing.eligSeasonComplete || missing.eligNoDiscipline || missing.eligCertsCurrent || missing.eligManagerApproved ? " is-missing" : ""}`}>
        <span>Eligibility</span>
        <em className={`kf-pe-elig${allChecked ? " is-done" : ""}`} data-elig>
          {checkedCount} of {eligChecks.length}
        </em>
        {eligChecks.map((c) => (
          <label key={c.key} className="kf-pe-check">
            <input
              type="checkbox"
              checked={f[c.key] === "true"}
              onChange={(e) => setElig(c.key, e.currentTarget.checked)}
            />
            <span className="kf-pe-check__box">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span className="kf-pe-check__text">
              <b>{c.label}</b>
              {c.sub ? <small>{c.sub}</small> : null}
            </span>
          </label>
        ))}
      </div>

      <Field label="Why does this person deserve a raise?" htmlFor="paf-why" error={missing.explanation ? "Needed" : null}>
        <textarea
          id="paf-why"
          rows={4}
          value={f.explanation}
          onChange={(e) => onChange({ explanation: e.currentTarget.value })}
          placeholder="What have they done? What has changed? Be specific."
        />
      </Field>
    </>
  );
}
