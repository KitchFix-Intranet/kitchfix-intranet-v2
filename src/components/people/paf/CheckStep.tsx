"use client";

// Check step. Person · every answered field as label and value ·
// Who sees it · Send (disabled in T4a).

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
    ? "nobody right now"
    : whoSeesIt.reviewers.join(", ");
  const copiedText = whoSeesIt.copied.length === 0
    ? ""
    : whoSeesIt.copied.join(", ");

  return (
    <>
      <div className="kf-pe-check-eyebrow">
        <span className="kf-eyebrow kf-eyebrow--plain">You are about to send</span>
        <h3>{actionLabel}{person ? ` for ${person.display_name}` : ""}</h3>
      </div>

      <div className="kf-pe-kvlist">
        <dl className="kf-kv" aria-label="What is in the request">
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

      <div className="kf-pe-sechead">
        <h3>Who sees it</h3>
      </div>
      <div className="kf-pe-note">
        <b>Sent to {whoSeesIt.route}.</b> {reviewersText} {whoSeesIt.reviewers.length === 1 ? "reviews it" : "review it"}
        {copiedText ? `; ${copiedText} are copied.` : "."}
      </div>
    </>
  );
}
