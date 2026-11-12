// Build the "detail pairs" list for a single submission record,
// shaped like the render's `_row` detail arrays. Pure function:
// takes the parsed payload + a couple of resolved names and returns
// an array of [label, value] pairs. Every field the form asks for
// shows up - "Not given" for blanks (R-PP30: nothing left out).
//
// Keys that belong to other action types in the payload are ignored
// because the v1 payload carries every field on every row.

import { fmtFull } from "./dates";
import { fmtMoney } from "./money";
import { resolveSite, type SiteIndex } from "./site";
import { separationType } from "./separation";

type Pair = [string, string];
type Payload = Record<string, unknown>;

const NOT_GIVEN = "Not given";

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return "";
}

function yesNo(v: unknown): string {
  if (v === true || v === "true" || v === "Yes" || v === "yes") return "Yes";
  if (v === false || v === "false" || v === "No" || v === "no") return "No";
  if (v == null || v === "") return NOT_GIVEN;
  return String(v);
}

function dateOr(v: unknown): string {
  const s = str(v);
  if (!s) return NOT_GIVEN;
  return fmtFull(s) || NOT_GIVEN;
}

function textOr(v: unknown): string {
  const s = str(v);
  return s || NOT_GIVEN;
}

function moneyOr(v: unknown): string {
  const f = fmtMoney(v);
  return f || NOT_GIVEN;
}

// Travel: eight perDiem_* count fields sum to a "meals each day"
// narrative. The render prints them as a single line of counts.
function perDiemLine(p: Payload): string {
  const parts: string[] = [];
  const add = (key: string, label: string) => {
    const n = Number(p[key]);
    if (Number.isFinite(n) && n > 0) parts.push(`${n} ${label}`);
  };
  add("perDiem_allMeals", "all meals");
  add("perDiem_bkfstLunch", "breakfast + lunch");
  add("perDiem_bkfstDinner", "breakfast + dinner");
  add("perDiem_lunchDinner", "lunch + dinner");
  add("perDiem_bkfstProvided", "breakfast provided");
  add("perDiem_lunchProvided", "lunch provided");
  add("perDiem_dinnerProvided", "dinner provided");
  add("perDiem_noMeals", "no meals");
  return parts.join(" · ") || NOT_GIVEN;
}

// "For" is the person the request is about. When person_worker_id
// is linked, prefer the resolved display_name (authoritative); else
// fall back to payload.employeeName.
function forLine(p: Payload, resolvedPersonName: string | null): string {
  if (resolvedPersonName && resolvedPersonName.trim()) return resolvedPersonName.trim();
  const s = str(p.employeeName);
  return s || NOT_GIVEN;
}

// T3.1 fix 4 (2026-11-13). Site resolution walks the three signals
// (payload.locationName -> payload.locationKey -> submissions.location),
// so older rows that only carry `submissions.location` ("STL - FL -
// St Louis Cardinals") still print "St Louis Cardinals" instead of
// "Not given".
function siteLine(p: Payload, submissionsLocation: string | null, index: SiteIndex): string {
  return resolveSite(p.locationName, p.locationKey, submissionsLocation, index) ?? NOT_GIVEN;
}

// Public entry. `action_type` picks the field list; `module === "newhire"`
// has its own list.
export function detailPairs(
  module: string | null,
  action_type: string | null,
  payload: Payload,
  resolvedPersonName: string | null,
  submissionsLocation: string | null,
  siteIndex: SiteIndex,
): Pair[] {
  const m = (module ?? "").toLowerCase();
  const a = (action_type ?? "").toLowerCase();

  if (m === "newhire" || a === "new_hire") {
    const first = str(payload.firstName);
    const last = str(payload.lastName);
    const both = [first, last].filter(Boolean).join(" ") || NOT_GIVEN;
    // T3.1 fix 8 + T4a Part 0 fix 4 (2026-11-13).
    // Tools and access uses the render's four names; render joins
    // them with ", " (comma), not " · ".
    const tools: string[] = [];
    if (payload.needsCard) tools.push("Company card");
    if (payload.needsEmail) tools.push("KitchFix email");
    if (payload.needsLaptop) tools.push("Company laptop");
    if (payload.needsCell) tools.push("Cell phone reimbursement");
    // T4a Part 0 fix 2 (2026-11-13). Site must go through
    // resolveSite as a KEY (not a name) so the combined
    // "STL - FL - St Louis Cardinals" shape in payload.operation
    // resolves to the clean club name via the SiteIndex. Passing
    // it as the first arg hit the "return the name as-is" branch
    // and leaked the combo string onto the card.
    const siteName = resolveSite(null, payload.operation, submissionsLocation, siteIndex) ?? NOT_GIVEN;
    // Worked here before -> "New to KitchFix" or "Returning".
    const isRehireVal = payload.isRehire;
    const workedHere = (isRehireVal === true || isRehireVal === "true" || isRehireVal === "Yes" || isRehireVal === "yes")
      ? "Returning"
      : (isRehireVal === false || isRehireVal === "false" || isRehireVal === "No" || isRehireVal === "no")
        ? "New to KitchFix"
        : NOT_GIVEN;
    return [
      ["For", both],
      ["Personal email", textOr(payload.personalEmail)],
      ["Worked here before", workedHere],
      ["Site", siteName],
      ["Reports to", textOr(payload.manager)],
      ["Job title", textOr(payload.jobTitle)],
      ["Pay type", textOr(payload.payType)],
      ["Rate", moneyOr(payload.payRate)],
      ["Full-time", yesNo(payload.isFullTime)],
      ["Start date", dateOr(payload.startDate)],
      ["Tools and access", tools.length ? tools.join(", ") : "None"],
    ];
  }

  if (a === "travel_reimbursement") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site visited", siteLine(payload, submissionsLocation, siteIndex)],
      ["Days away", textOr(payload.travelTotalDays)],
      ["Effective date", dateOr(payload.effectiveDate ?? payload.travelStartDate)],
      ["Meals each day", perDiemLine(payload)],
      ["Travel supplement", payload.travelSupplementEnabled ? moneyOr(payload.travelSupplementTotal) : NOT_GIVEN],
      ["Per diem total", moneyOr(payload.perDiemTotal ?? payload.travelGrandTotal)],
      ["Business purpose", textOr(payload.explanation)],
    ];
  }

  if (a === "separation") {
    // T4b-1 (2026-11-14). Type is Voluntary or Involuntary. New
    // drafts + sends carry it in `actionGroup` (the field the viewer
    // picked); older rows that predate the form rebuild fall back to
    // deriving the type from the reason via separationType(). All 75
    // existing separations in the DB today have actionGroup set, so
    // the fallback only runs on a defective row.
    const reason = str(payload.separationReason ?? payload.replacementReason);
    const ag = str(payload.actionGroup);
    const typeDisplay =
      ag === "Voluntary" || ag === "Involuntary"
        ? ag
        : separationType(reason);
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Type", typeDisplay],
      ["Reason", reason || NOT_GIVEN],
      ["Last day worked", dateOr(payload.lastDayWorked)],
      ["Eligible to rehire", yesNo(payload.rehireEligible)],
    ];
  }

  if (a === "add_bonus" || a === "add_deduction" || a === "other_reimbursement") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Amount", moneyOr(payload.amount)],
      ["Reason", textOr(payload.explanation)],
      ["Receipt", str(payload.uploadFileName) ? "On file" : NOT_GIVEN],
    ];
  }

  if (a === "add_cell_phone") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Amount", moneyOr(payload.amount)],
      ["Frequency", textOr(payload.cellFrequency)],
      ["Device details", textOr(payload.currentDeviceDetails)],
      ["Ship to", textOr(payload.equipmentShipTo)],
      ["Request", textOr(payload.equipmentRequestType)],
      ["Receipt", str(payload.uploadFileName) ? "On file" : NOT_GIVEN],
    ];
  }

  if (a === "title_change") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Old title", textOr(payload.oldTitle)],
      ["New title", textOr(payload.newTitle)],
      ["Reason", textOr(payload.explanation)],
    ];
  }

  if (a === "rate_change") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Old rate", moneyOr(payload.oldRate)],
      ["New rate", moneyOr(payload.newRate)],
      ["Reason", textOr(payload.explanation)],
    ];
  }

  if (a === "status_change") {
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Change", textOr(payload.statusChangeDirection ?? payload.reclassChangeRate)],
      ["Old", textOr(payload.reclassFrom ?? payload.oldTitle)],
      ["New", textOr(payload.reclassTo ?? payload.newTitle)],
      ["Reason", textOr(payload.explanation)],
    ];
  }

  if (a === "pay_increase") {
    const confirmed =
      (payload.eligSeasonComplete ? 1 : 0) +
      (payload.eligCertsCurrent ? 1 : 0) +
      (payload.eligNoDiscipline ? 1 : 0) +
      (payload.eligManagerApproved ? 1 : 0);
    return [
      ["For", forLine(payload, resolvedPersonName)],
      ["Site", siteLine(payload, submissionsLocation, siteIndex)],
      ["Effective date", dateOr(payload.effectiveDate)],
      ["Old rate", moneyOr(payload.oldRate)],
      ["New rate", moneyOr(payload.newRate)],
      ["Increase type", textOr(payload.increaseType)],
      ["Dollar increase", moneyOr(payload.dollarIncrease)],
      ["Percent increase", textOr(payload.pctIncrease)],
      ["Level", textOr(payload.employeeLevel)],
      ["Role", textOr(payload.role ?? payload.customRole)],
      ["Confirmed", `${confirmed} of 4 confirmed`],
    ];
  }

  // Fallback: a module we do not have a sheet for. Show the headline
  // fields so the viewer sees who and when, not blank.
  return [
    ["For", forLine(payload, resolvedPersonName)],
    ["Site", siteLine(payload, submissionsLocation, siteIndex)],
    ["Effective date", dateOr(payload.effectiveDate)],
    ["Reason", textOr(payload.explanation)],
  ];
}
