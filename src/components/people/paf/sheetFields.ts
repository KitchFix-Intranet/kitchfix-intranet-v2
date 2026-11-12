// T4b-1 (2026-11-14). Shared field names + per-action required
// rules + per-action payload shape. One module so PafFlow, the
// five sheet components, Check, and the drafts API whitelist all
// agree on the exact v1 key names.

import type { PafAction } from "./WhatStep";

// v1 payload keys we write in this train. Everything is a string
// except conditional booleans (stored as "Yes" / "No") so recordDetail
// can read old + new records the same way.
export interface SheetFields {
  amount: string;             // add_bonus, add_deduction, add_gratuity, add_cell_phone, (conditional) title_change, reclassification
  effectiveDate: string;      // every sheet
  lastDayWorked: string;      // separation only
  actionGroup: "Voluntary" | "Involuntary" | "";  // separation Type
  separationReason: string;   // separation
  rehireEligible: "Yes" | "No" | "";  // separation
  explanation: string;        // most sheets; optional on separation
  oldTitle: string;           // read-only, set server-side
  newTitle: string;           // title_change + reclassification
  reclassChangeRate: "Yes" | "No" | "";  // title_change + reclassification
  newRate: string;            // money, conditional
  statusChangeDirection: string;  // status_change
  reclassFrom: string;        // reclassification
  reclassTo: string;          // reclassification
  reclassTitleChange: "Yes" | "No" | "";  // reclassification
  cellFrequency: "Monthly" | "Bi-weekly" | "";  // add_cell_phone
}

export const EMPTY_FIELDS: SheetFields = {
  amount: "",
  effectiveDate: "",
  lastDayWorked: "",
  actionGroup: "",
  separationReason: "",
  rehireEligible: "",
  explanation: "",
  oldTitle: "",
  newTitle: "",
  reclassChangeRate: "",
  newRate: "",
  statusChangeDirection: "",
  reclassFrom: "",
  reclassTo: "",
  reclassTitleChange: "",
  cellFrequency: "",
};

// Required-field map per action. Returns the keys that must be
// filled for the action to pass Check.
//
// Conditional rules (not expressible as a flat list) live in the
// per-action validator below.
export function requiredFieldsFor(action: PafAction | null, f: SheetFields): string[] {
  if (!action) return [];
  if (action === "add_bonus" || action === "add_deduction" || action === "add_gratuity") {
    return ["amount", "effectiveDate", "explanation"];
  }
  if (action === "add_cell_phone") {
    return ["amount", "cellFrequency", "effectiveDate"];
  }
  if (action === "separation") {
    return ["effectiveDate", "lastDayWorked", "actionGroup", "separationReason", "rehireEligible"];
  }
  if (action === "title_change") {
    const base = ["effectiveDate", "newTitle", "reclassChangeRate", "explanation"];
    if (f.reclassChangeRate === "Yes") base.push("newRate");
    return base;
  }
  if (action === "status_change") {
    return ["effectiveDate", "statusChangeDirection"];
  }
  if (action === "reclassification") {
    const base = ["effectiveDate", "reclassFrom", "reclassTo", "reclassTitleChange", "reclassChangeRate", "explanation"];
    if (f.reclassTitleChange === "Yes") base.push("newTitle");
    if (f.reclassChangeRate === "Yes") base.push("newRate");
    return base;
  }
  return [];
}

// Short human name per key for the "Still needed" summary + the
// field error label.
export const FIELD_LABEL: Record<string, string> = {
  amount: "Amount",
  effectiveDate: "Effective date",
  lastDayWorked: "Last day worked",
  actionGroup: "Type",
  separationReason: "Reason",
  rehireEligible: "Eligible to rehire",
  explanation: "What it is for",
  oldTitle: "Current role",
  newTitle: "New role",
  reclassChangeRate: "Pay change",
  newRate: "New rate",
  statusChangeDirection: "What is changing",
  reclassFrom: "From",
  reclassTo: "To",
  reclassTitleChange: "Title change",
  cellFrequency: "Frequency",
};

// Compute missing-field set. The server-authoritative fields
// (oldTitle, etc.) are not surfaced to the viewer as "missing";
// they are filled server-side when the draft saves.
export type MissingSet = Partial<Record<keyof SheetFields, boolean>>;

export function missingFor(action: PafAction | null, f: SheetFields): MissingSet {
  const missing: MissingSet = {};
  const reqs = requiredFieldsFor(action, f);
  for (const key of reqs) {
    const k = key as keyof SheetFields;
    const v = f[k];
    if (k === "amount" || k === "newRate") {
      if (!(Number(v) > 0)) missing[k] = true;
    } else if (!v || (typeof v === "string" && !v.trim())) {
      missing[k] = true;
    }
  }
  return missing;
}

// Named list of missing fields, for the "Still needed: ..."
// summary at the top of Details.
export function missingSummary(missing: MissingSet): string[] {
  const names: string[] = [];
  for (const key of Object.keys(missing)) {
    if (missing[key as keyof SheetFields]) names.push(FIELD_LABEL[key] ?? key);
  }
  return names;
}
