// Ready check for a draft. Pure (the server-only copy-check runs
// elsewhere; see duplicateCheck.ts). Returns the list of errors the
// client's "Check and send" shows. Train 2 never writes the Ready
// state - this is derived on every check call.
//
// Corrections 10:
//   isReady also checks that every code in gl_breakdown is an active
//   code for that site, every amount is above zero, and type is
//   invoice or credit. Those are enforced by threading the site's
//   active-code set and matching strict typing in the checker.

import type { CheckError, CheckResult, DraftRow, FileRow, InvoiceKind } from "./types";
import { addsUp } from "./addUp";
import { parseDateInput } from "./dateInput";

export interface ReadyInputs {
  draft: DraftRow;
  files: readonly FileRow[];
  // Codes active for the draft's site. Caller loads these once and
  // passes them in - the checker stays pure.
  activeCodesForSite: ReadonlySet<string>;
  // Vendor exists and is not deleted, in the viewer's scope.
  vendorInScope: boolean;
  // Copy-check verdict from the server (duplicateCheck.ts).
  copyError: null | "same_invoice" | "same_draft";
}

const VALID_KINDS: readonly InvoiceKind[] = ["invoice", "credit"];

export function runReadyCheck(inputs: ReadyInputs): CheckResult {
  const { draft, files, activeCodesForSite, vendorInScope, copyError } = inputs;
  const errors: CheckError[] = [];

  if (!draft.vendor_id || !vendorInScope) {
    errors.push({ field: "vendor_id", message: "Pick a vendor." });
  }

  if (!VALID_KINDS.includes(draft.type)) {
    errors.push({ field: "type", message: "Choose invoice or credit." });
  }

  const invNum = (draft.invoice_number ?? "").trim();
  if (!invNum) {
    errors.push({ field: "invoice_number", message: "Type the invoice number." });
  } else if (invNum.length > 50) {
    errors.push({ field: "invoice_number", message: "Invoice number is too long." });
  }

  if (!draft.invoice_date) {
    errors.push({ field: "invoice_date", message: "Type the invoice date." });
  } else {
    const parsed = parseDateInput(draft.invoice_date);
    if (!parsed.iso) {
      errors.push({ field: "invoice_date", message: "That date is not a date." });
    } else if (parsed.future) {
      errors.push({ field: "invoice_date", message: "The date is in the future." });
    } else if (parsed.moreThan60DaysBack && !draft.answers.date_confirmed_at_more_than_60_days) {
      errors.push({
        field: "date_more_than_60",
        message: "This date is more than 60 days back. Confirm it is right.",
      });
    }
  }

  if (draft.total_amount == null) {
    errors.push({ field: "total_amount", message: "Type the total." });
  } else if (!(draft.total_amount > 0)) {
    errors.push({ field: "total_amount", message: "The total must be more than zero." });
  }

  // gl_breakdown: every amount > 0, every code in the active set,
  // adds up to the total to the cent.
  const gl = draft.gl_breakdown ?? [];
  if (gl.length === 0) {
    errors.push({ field: "gl_breakdown", message: "Code the invoice." });
  } else {
    for (const line of gl) {
      if (!(line.amount > 0)) {
        errors.push({ field: "gl_breakdown", message: `Amounts must be more than zero (${line.code}).` });
        break;
      }
      if (!activeCodesForSite.has(line.code)) {
        errors.push({ field: "gl_breakdown", message: `Code ${line.code} is not an active code for this site.` });
        break;
      }
    }
    if (!addsUp(draft.total_amount ?? null, gl)) {
      errors.push({ field: "gl_breakdown", message: "The coding does not add up to the total." });
    }
  }

  const liveFiles = files.filter((f) => f.removed_at == null);
  if (liveFiles.length === 0) {
    errors.push({ field: "files", message: "Add the page." });
  }

  if (copyError === "same_invoice") {
    errors.push({ field: "copy", message: "There is already an invoice with this number for this vendor at this site." });
  } else if (copyError === "same_draft") {
    errors.push({ field: "copy", message: "You already have a draft with this number for this vendor." });
  }

  return { ready: errors.length === 0, errors };
}
