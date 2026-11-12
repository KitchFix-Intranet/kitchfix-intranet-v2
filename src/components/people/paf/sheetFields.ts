// T4b-2 (2026-11-14). Shared field names + per-action required
// rules + per-action payload shape. One module so PafFlow, the
// nine sheet components, Check and the drafts API whitelist all
// agree on the exact v1 key names.
//
// String-only state, except for conditional "Yes" / "No" values
// (also strings). Booleans from v1's equipment checkboxes are
// stored as "true" / "false" strings so recordDetail reads old +
// new records the same way.

import type { PafAction } from "./WhatStep";
import type { PerDiemDay } from "@/lib/people/perDiem";

export interface SheetFields {
  // ---------- shared ----------
  amount: string;
  effectiveDate: string;
  explanation: string;

  // ---------- separation ----------
  lastDayWorked: string;
  actionGroup: "Voluntary" | "Involuntary" | "";
  separationReason: string;
  rehireEligible: "Yes" | "No" | "";

  // ---------- title_change + reclassification ----------
  oldTitle: string;             // server-authoritative
  newTitle: string;
  reclassChangeRate: "Yes" | "No" | "";
  newRate: string;              // money

  // ---------- status_change ----------
  statusChangeDirection: string;

  // ---------- reclassification ----------
  reclassFrom: string;
  reclassTo: string;
  reclassTitleChange: "Yes" | "No" | "";

  // ---------- add_cell_phone ----------
  cellFrequency: "Monthly" | "Bi-weekly" | "";

  // ---------- pay_increase ----------
  increaseType: string;
  employeeLevel: "hourly" | "leadership" | "";
  role: string;
  customRole: string;
  oldRate: string;              // money
  // dollarIncrease + pctIncrease are server-authoritative and not
  // stored client-side; they are recomputed on every save.
  eligSeasonComplete: "true" | "false" | "";
  eligNoDiscipline: "true" | "false" | "";
  eligCertsCurrent: "true" | "false" | "";
  eligManagerApproved: "true" | "false" | "";

  // ---------- travel_reimbursement ----------
  // For travel the "site visited" is NOT the person's own site;
  // locationKey + locationName are user input (validated against
  // accounts on the server). We hold them in SheetFields so the
  // Select for site visited round-trips on draft save.
  locationKey: string;
  locationName: string;
  travelStartDate: string;
  travelEndDate: string;
  perDiemDays: PerDiemDay[];    // v2 addition: per-day tier choices
  travelSupplementEnabled: "Yes" | "No" | "";

  // ---------- equipment_request ----------
  equipmentRequestType: "new" | "replacement" | "";
  replacementReason: string;
  confirmReported: "true" | "false" | "";
  currentDeviceDetails: string;
  equipmentShipTo: string;
  equipmentNotes: string;       // v2 addition
  confirmReturn: "true" | "false" | "";
}

export const EMPTY_FIELDS: SheetFields = {
  amount: "",
  effectiveDate: "",
  explanation: "",
  lastDayWorked: "",
  actionGroup: "",
  separationReason: "",
  rehireEligible: "",
  oldTitle: "",
  newTitle: "",
  reclassChangeRate: "",
  newRate: "",
  statusChangeDirection: "",
  reclassFrom: "",
  reclassTo: "",
  reclassTitleChange: "",
  cellFrequency: "",
  increaseType: "",
  employeeLevel: "",
  role: "",
  customRole: "",
  oldRate: "",
  eligSeasonComplete: "",
  eligNoDiscipline: "",
  eligCertsCurrent: "",
  eligManagerApproved: "",
  locationKey: "",
  locationName: "",
  travelStartDate: "",
  travelEndDate: "",
  perDiemDays: [],
  travelSupplementEnabled: "",
  equipmentRequestType: "",
  replacementReason: "",
  confirmReported: "",
  currentDeviceDetails: "",
  equipmentShipTo: "",
  equipmentNotes: "",
  confirmReturn: "",
};

// Required-field map per action. Returns the keys that must be
// filled for the action to pass Check.
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
  if (action === "pay_increase") {
    const base = ["effectiveDate", "increaseType", "employeeLevel", "role", "oldRate", "newRate", "explanation"];
    if (f.role === "Other") base.push("customRole");
    return base;
  }
  if (action === "travel_reimbursement") {
    return ["locationKey", "travelStartDate", "travelEndDate", "perDiemDays", "explanation"];
  }
  if (action === "other_reimbursement") {
    return ["amount", "effectiveDate", "explanation"];
  }
  if (action === "equipment_request") {
    const base = ["equipmentRequestType", "equipmentShipTo"];
    if (f.equipmentRequestType === "new") base.push("explanation");
    if (f.equipmentRequestType === "replacement") {
      base.push("replacementReason", "currentDeviceDetails", "confirmReturn");
      if (f.replacementReason === "Lost" || f.replacementReason === "Stolen") base.push("confirmReported");
    }
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
  increaseType: "Increase type",
  employeeLevel: "Employee level",
  role: "Role",
  customRole: "Which role",
  oldRate: "Current rate",
  locationKey: "Site visited",
  travelStartDate: "First day",
  travelEndDate: "Last day",
  perDiemDays: "Meals each day",
  travelSupplementEnabled: "Travel supplement",
  equipmentRequestType: "Request",
  replacementReason: "Reason for replacement",
  confirmReported: "Reported to Senior Director",
  currentDeviceDetails: "Current device",
  equipmentShipTo: "Ship to",
  equipmentNotes: "Anything else",
  confirmReturn: "Device return",
};

export type MissingSet = Partial<Record<keyof SheetFields, boolean>>;

export function missingFor(action: PafAction | null, f: SheetFields): MissingSet {
  const missing: MissingSet = {};
  const reqs = requiredFieldsFor(action, f);
  for (const key of reqs) {
    const k = key as keyof SheetFields;
    const v = f[k];
    if (k === "amount" || k === "newRate" || k === "oldRate") {
      if (!(Number(v) > 0)) missing[k] = true;
    } else if (k === "perDiemDays") {
      // All days must have a tier picked.
      const days = f.perDiemDays;
      if (!days || days.length === 0 || days.some((d) => !d.tier)) missing[k] = true;
    } else if (k === "confirmReported" || k === "confirmReturn") {
      if (v !== "true") missing[k] = true;
    } else if (typeof v === "string") {
      if (!v.trim()) missing[k] = true;
    } else if (!v) {
      missing[k] = true;
    }
  }
  return missing;
}

export function missingSummary(missing: MissingSet): string[] {
  const names: string[] = [];
  for (const key of Object.keys(missing)) {
    if (missing[key as keyof SheetFields]) names.push(FIELD_LABEL[key] ?? key);
  }
  return names;
}
