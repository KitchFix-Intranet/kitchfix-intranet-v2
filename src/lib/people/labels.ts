// Human labels for submissions.action_type. One map, used by every
// surface that names a request (the "You" row, the card's In flight
// rows, the card's History rows, and the restricted-viewer state-only
// notes). Never the raw code, never a "PAF:" prefix - a request
// reads as its action, not the module that routed it.
//
// The map covers every action_type present in submissions today.
// Unknown codes fall through to a title-cased version of the code
// itself (underscores to spaces, first letter capitalised) so a new
// action_type added in the DB still renders as words.

export const ACTION_LABEL: Record<string, string> = {
  travel_reimbursement: "Travel reimbursement",
  other_reimbursement: "Other reimbursement",
  separation: "Separation",
  add_bonus: "One-time bonus",
  title_change: "Title change",
  add_deduction: "Deduction",
  rate_change: "Rate change",
  add_cell_phone: "Cell phone",
  pay_increase: "Pay increase",
  status_change: "Status change",
  new_hire: "New Hire",
};

function titleFromCode(code: string): string {
  const spaced = code.replace(/_/g, " ").trim();
  if (!spaced) return "Request";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// T3 (2026-11-13). Where a submission routes: HR handles people
// moves (separation, title change, status change, new hire);
// everything else is payroll / finance. Used for the "Needs you"
// "why" text ("14 days with finance") and the record drawer
// ledger's "Sent to ..." line. One function, one source of truth.
export type RequestRoute = "HR" | "finance";
const HR_ACTIONS: ReadonlySet<string> = new Set([
  "separation", "title_change", "status_change", "new_hire",
]);
export function routeFor(action_type: string | null): RequestRoute {
  const a = (action_type ?? "").trim();
  return HR_ACTIONS.has(a) ? "HR" : "finance";
}

// Short human label for a submission. `module` is retained in the
// signature (and used for fallbacks: incident, termination) but
// the primary signal is `action_type` - the thing that happened.
// Nothing here emits "PAF:" or "Incident:" as a prefix: the label
// is the action, not the delivery lane.
export function labelForAction(
  module: string | null,
  action_type: string | null,
): string {
  const a = (action_type ?? "").trim();
  if (a) return ACTION_LABEL[a] ?? titleFromCode(a);
  const m = (module ?? "").trim().toLowerCase();
  if (m === "incident") return "Incident";
  if (m === "termination") return "Termination";
  if (m === "paf") return "PAF";
  if (m === "newhire") return "New Hire";
  if (m) return m.charAt(0).toUpperCase() + m.slice(1);
  return "Request";
}
