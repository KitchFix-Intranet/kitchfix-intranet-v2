"use client";

// T4a.1 (2026-11-14). Check mirrors the render:
//   - Person card at the top (.kf-pe-about).
//   - KV list, Action first, then the answered fields.
//   - "Who sees it" NOTE box under the KV list (not a sechead).
// Send button is rendered in PafFlow's footer (disabled in T4a).

import type { PafAction } from "./WhatStep";
import { ACTION_LABEL, type RequestRoute } from "@/lib/people/labels";
import { fmtFull } from "@/lib/people/dates";
import { fmtMoney } from "@/lib/people/money";

export type WhoSeesItView = {
  route: RequestRoute;
  reviewers: string[];
  copied: string[];
};

export function CheckStep({
  action, person, amount, effectiveDate, explanation, whoSeesIt,
}: {
  action: PafAction;
  person: { worker_id: string; display_name: string } | null;
  amount: string;
  effectiveDate: string;
  explanation: string;
  whoSeesIt: WhoSeesItView;
}) {
  const actionLabel = ACTION_LABEL[action] ?? action;
  const amountMoney = fmtMoney(amount);
  const dateFull = effectiveDate ? fmtFull(effectiveDate) : "";

  const reviewersText = whoSeesIt.reviewers.length === 0
    ? "nobody is set up to review yet"
    : whoSeesIt.reviewers.join(", ");
  const copiedTail = whoSeesIt.copied.length === 0
    ? ""
    : ` ${whoSeesIt.copied.join(", ")} ${whoSeesIt.copied.length === 1 ? "is" : "are"} copied.`;

  return (
    <>
      {person ? (
        <div className="kf-pe-about">
          <span className="kf-pe-ava" aria-hidden>
            {(person.display_name || "?").split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
          </span>
          <span className="kf-pe-about__who">
            <b data-about="name">{person.display_name}</b>
          </span>
        </div>
      ) : null}

      <div className="kf-pe-kvlist">
        <dl className="kf-kv" aria-label="What is in the request">
          {/* Action row first - matches the render's _row detail
           * array ordering for every PAF action. */}
          <div>
            <dt>Action</dt>
            <dd>{actionLabel}</dd>
          </div>
          <div>
            <dt>For</dt>
            <dd>{person?.display_name || "-"}</dd>
          </div>
          {amountMoney ? (
            <div>
              <dt>Amount</dt>
              <dd>{amountMoney}</dd>
            </div>
          ) : null}
          {dateFull ? (
            <div>
              <dt>Effective date</dt>
              <dd>{dateFull}</dd>
            </div>
          ) : null}
          {explanation ? (
            <div>
              <dt>What it is for</dt>
              <dd>{explanation}</dd>
            </div>
          ) : null}
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
