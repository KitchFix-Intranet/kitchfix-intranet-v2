"use client";

// T4b-1 (2026-11-14). Check mirrors the render for all nine
// currently-selectable actions:
//   - Person card at the top (.kf-pe-about with title + club name).
//   - KV list: Action first, then each ANSWERED field in the
//     sheet's natural order. Hidden conditional fields are omitted;
//     blank optional fields read "Not given" (recordDetail rule).
//   - "Who sees it" NOTE box under the KV list.
//
// T4a.1 Part 0 #6: the "For" row is REMOVED. The person card
// above already says who it is for.

import type { PafAction } from "./WhatStep";
import { ACTION_LABEL, type RequestRoute } from "@/lib/people/labels";
import { fmtFull } from "@/lib/people/dates";
import { fmtMoney } from "@/lib/people/money";
import { SheetAbout } from "./SheetAbout";
import type { SheetFields } from "./sheetFields";
import type { SelectOption } from "./Select";

export type WhoSeesItView = {
  route: RequestRoute;
  reviewers: string[];
  copied: string[];
};

type Row = { label: string; value: string };

const NOT_GIVEN = "Not given";

function yesNoOr(v: string, fallback = NOT_GIVEN): string {
  if (v === "Yes" || v === "No") return v;
  return fallback;
}
function textOrNotGiven(v: string): string {
  return (v ?? "").trim() || NOT_GIVEN;
}
function moneyOrNotGiven(v: string): string {
  const f = fmtMoney(v);
  return f || NOT_GIVEN;
}
function dateOrNotGiven(v: string): string {
  if (!v) return NOT_GIVEN;
  return fmtFull(v) || NOT_GIVEN;
}

function rowsForAction(
  action: PafAction,
  fields: SheetFields,
  accountOptions: readonly SelectOption[],
): Row[] {
  const labelForAccount = (key: string) =>
    accountOptions.find((o) => o.value === key)?.label || key || NOT_GIVEN;

  if (action === "add_bonus" || action === "add_deduction" || action === "add_gratuity" || action === "add_cell_phone") {
    const rows: Row[] = [];
    rows.push({ label: "Amount", value: moneyOrNotGiven(fields.amount) });
    if (action === "add_cell_phone") rows.push({ label: "Frequency", value: textOrNotGiven(fields.cellFrequency) });
    rows.push({ label: "Effective date", value: dateOrNotGiven(fields.effectiveDate) });
    if (action !== "add_cell_phone") rows.push({ label: "What it is for", value: textOrNotGiven(fields.explanation) });
    return rows;
  }

  if (action === "separation") {
    return [
      { label: "Effective date",      value: dateOrNotGiven(fields.effectiveDate) },
      { label: "Last day worked",     value: dateOrNotGiven(fields.lastDayWorked) },
      { label: "Type",                value: textOrNotGiven(fields.actionGroup) },
      { label: "Reason",              value: textOrNotGiven(fields.separationReason) },
      { label: "Eligible to rehire",  value: yesNoOr(fields.rehireEligible) },
      { label: "Anything HR should know", value: textOrNotGiven(fields.explanation) },
    ];
  }

  if (action === "title_change") {
    const rows: Row[] = [
      { label: "Effective date", value: dateOrNotGiven(fields.effectiveDate) },
      { label: "Current role",   value: textOrNotGiven(fields.oldTitle) },
      { label: "New role",       value: textOrNotGiven(fields.newTitle) },
      { label: "Pay change",     value: yesNoOr(fields.reclassChangeRate) },
    ];
    if (fields.reclassChangeRate === "Yes") rows.push({ label: "New rate", value: moneyOrNotGiven(fields.newRate) });
    rows.push({ label: "Why", value: textOrNotGiven(fields.explanation) });
    return rows;
  }

  if (action === "status_change") {
    return [
      { label: "Effective date",    value: dateOrNotGiven(fields.effectiveDate) },
      { label: "What is changing",  value: textOrNotGiven(fields.statusChangeDirection) },
      { label: "Anything HR should know", value: textOrNotGiven(fields.explanation) },
    ];
  }

  if (action === "reclassification") {
    const rows: Row[] = [
      { label: "Effective date", value: dateOrNotGiven(fields.effectiveDate) },
      { label: "From",           value: labelForAccount(fields.reclassFrom) },
      { label: "To",             value: labelForAccount(fields.reclassTo) },
      { label: "Title change",   value: yesNoOr(fields.reclassTitleChange) },
    ];
    if (fields.reclassTitleChange === "Yes") {
      rows.push({ label: "Current title", value: textOrNotGiven(fields.oldTitle) });
      rows.push({ label: "New title",     value: textOrNotGiven(fields.newTitle) });
    }
    rows.push({ label: "Pay change", value: yesNoOr(fields.reclassChangeRate) });
    if (fields.reclassChangeRate === "Yes") rows.push({ label: "New rate", value: moneyOrNotGiven(fields.newRate) });
    rows.push({ label: "Reason for transfer", value: textOrNotGiven(fields.explanation) });
    return rows;
  }

  return [];
}

export function CheckStep({
  action, person, fields, whoSeesIt, accountOptions,
}: {
  action: PafAction;
  person: { display_name: string; title?: string | null; site_name?: string | null } | null;
  fields: SheetFields;
  whoSeesIt: WhoSeesItView;
  accountOptions: readonly SelectOption[];
}) {
  const actionLabel = ACTION_LABEL[action] ?? action;
  const rows = rowsForAction(action, fields, accountOptions);

  const reviewersText = whoSeesIt.reviewers.length === 0
    ? "nobody is set up to review yet"
    : whoSeesIt.reviewers.join(", ");
  const copiedTail = whoSeesIt.copied.length === 0
    ? ""
    : ` ${whoSeesIt.copied.join(", ")} ${whoSeesIt.copied.length === 1 ? "is" : "are"} copied.`;

  return (
    <>
      {person ? <SheetAbout person={person} /> : null}

      <div className="kf-pe-kvlist">
        <dl className="kf-kv" aria-label="What is in the request">
          {/* Action is always first. The "For" row from T4a.1 was
           * removed in T4a.1 Part 0 #6 - the person card above
           * already names the viewer and route. */}
          <div>
            <dt>Action</dt>
            <dd>{actionLabel}</dd>
          </div>
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="kf-pe-note">
        <b>Who sees it</b> Sent to {whoSeesIt.route}. {reviewersText}
        {whoSeesIt.reviewers.length === 1 ? " reviews it." : whoSeesIt.reviewers.length > 1 ? " review it." : "."}
        {copiedTail}
      </div>
    </>
  );
}
