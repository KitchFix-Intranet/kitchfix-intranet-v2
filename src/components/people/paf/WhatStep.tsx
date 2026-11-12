"use client";

// T4a.1 (2026-11-14). Four accordion group cards (kf-pe-agroup),
// closed on arrival. Twelve actions per the render's table:
//
//   HR actions (4 · goes to HR)
//     Separation             Someone is leaving KitchFix
//     Change in title        Same person, new title
//     Part-time or full-time Hours status changes
//     Reclassification       Moves to another department
//   Payroll (4 · goes to finance)
//     Pay increase recommendation  Propose a raise
//     One-time bonus               A single extra payment
//     One-time deduction           A single payroll deduction
//     Gratuity                     Tips to pay out
//   Expenses (3 · goes to finance)
//     Travel reimbursement         Per diem for days away
//     Cell phone reimbursement     Monthly phone stipend
//     Other reimbursement          Something else you paid for
//   IT and equipment (1 · goes to HR)
//     Equipment or laptop request  Hardware for someone
//
// Three selectable in T4a: add_bonus, add_deduction, add_gratuity.
// The other nine render in-place with .is-off (disabled). One short
// note under all four groups says the rest arrive next.

import { useState } from "react";
import { SheetAbout } from "./SheetAbout";

export type PafAction =
  | "add_bonus"
  | "add_deduction"
  | "add_gratuity"
  | "other_reimbursement"
  | "travel_reimbursement"
  | "title_change"
  | "status_change"
  | "rate_change"           // T4a kept for type-compat; not shown
  | "pay_increase"
  | "add_cell_phone"
  | "separation"
  | "reclassification"
  | "equipment_request";

type GroupDef = {
  key: string;
  heading: string;
  countLine: string;
  actions: Array<{ id: PafAction; label: string; sub: string; enabled: boolean }>;
};

const GROUPS: GroupDef[] = [
  {
    key: "hr",
    heading: "HR actions",
    countLine: "4 actions · goes to HR",
    actions: [
      { id: "separation",       label: "Separation",             sub: "Someone is leaving KitchFix",    enabled: true  },
      { id: "title_change",     label: "Change in title",        sub: "Same person, new title",         enabled: true  },
      { id: "status_change",    label: "Part-time or full-time", sub: "Hours status changes",           enabled: true  },
      { id: "reclassification", label: "Reclassification",       sub: "Moves to another department",    enabled: true  },
    ],
  },
  {
    key: "payroll",
    heading: "Payroll",
    countLine: "4 actions · goes to finance",
    actions: [
      { id: "pay_increase",  label: "Pay increase recommendation", sub: "Propose a raise",            enabled: false },
      { id: "add_bonus",     label: "One-time bonus",              sub: "A single extra payment",     enabled: true  },
      { id: "add_deduction", label: "One-time deduction",          sub: "A single payroll deduction", enabled: true  },
      { id: "add_gratuity",  label: "Gratuity",                    sub: "Tips to pay out",            enabled: true  },
    ],
  },
  {
    key: "expenses",
    heading: "Expenses",
    countLine: "3 actions · goes to finance",
    actions: [
      { id: "travel_reimbursement", label: "Travel reimbursement",     sub: "Per diem for days away",       enabled: false },
      { id: "add_cell_phone",       label: "Cell phone reimbursement", sub: "Monthly phone stipend",        enabled: true  },
      { id: "other_reimbursement",  label: "Other reimbursement",      sub: "Something else you paid for",  enabled: false },
    ],
  },
  {
    key: "it",
    heading: "IT and equipment",
    countLine: "1 action · goes to HR",
    actions: [
      { id: "equipment_request", label: "Equipment or laptop request", sub: "Hardware for someone", enabled: false },
    ],
  },
];

export function WhatStep({
  person, chosen, onChoose, onChange,
}: {
  person: { display_name: string; title?: string | null; site_name?: string | null } | null;
  chosen: PafAction | null;
  onChoose: (a: PafAction) => void;
  onChange: () => void;
}) {
  // Which group holds the chosen action? Open it on arrival.
  const groupKeyFor = (a: PafAction | null): string | null => {
    if (!a) return null;
    for (const g of GROUPS) if (g.actions.some((r) => r.id === a)) return g.key;
    return null;
  };
  const [openKey, setOpenKey] = useState<string | null>(groupKeyFor(chosen));

  return (
    <>
      {person ? <SheetAbout person={person} onChange={onChange} /> : null}

      {GROUPS.map((g) => {
        const open = openKey === g.key;
        return (
          <div key={g.key} className={`kf-pe-agroup${open ? "" : " is-collapsed"}`}>
            <button
              type="button"
              className="kf-pe-agroup__head"
              aria-expanded={open ? "true" : "false"}
              onClick={() => setOpenKey(open ? null : g.key)}
            >
              <b>{g.heading}</b>
              <small>{g.countLine}</small>
              <svg
                className="kf-pe-sitehead__chev"
                width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div className="kf-pe-typelist" role="radiogroup" aria-label={g.heading}>
              {g.actions.map((row) => {
                const isChosen = chosen === row.id;
                const cls = [
                  "kf-pe-typerow",
                  isChosen ? "is-selected" : "",
                  row.enabled ? "" : "is-off",
                ].filter(Boolean).join(" ");
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={cls}
                    role="radio"
                    aria-checked={isChosen ? "true" : "false"}
                    aria-disabled={row.enabled ? undefined : "true"}
                    disabled={!row.enabled}
                    onClick={() => { if (row.enabled) onChoose(row.id); }}
                  >
                    <span className="kf-pe-radio" aria-hidden />
                    <span className="kf-pe-typerow__text">
                      <b>{row.label}</b>
                      <small>{row.sub}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <p className="kf-pe-muted kf-pe-small kf-pe-group-note">
        The other four arrive in the next release.
      </p>
    </>
  );
}
