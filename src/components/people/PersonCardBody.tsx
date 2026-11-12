// Person-card body. Server component - the R-PP10 contact rule is
// enforced before this file runs (see src/lib/people/contact.ts
// toCardPerson). This file only renders the already-sanitised
// CardPerson shape. Phone digits reach the DOM only through tel:
// and sms: href attributes.
//
// Pin 4 (2026-11-11): Reports to shows the manager's name only.
// No link, no card trigger, even when the manager is out of scope.
// Pin 5 (2026-11-11): dates - full ("Nov 9, 2026") on the card; "N
// days" only for how long a request has waited.
//
// Floors (2026-11-12): chef-floor surface. No kf-btn--sm anywhere
// on the card. The inert / disabled visual state uses the shared
// .kf-pe-disabled class + aria-disabled="true" - no inline styles.

import { Phone, MessageCircle, Mail } from "lucide-react";
import type { CardPerson } from "@/lib/people/types";
import { fmtShort, fmtFull, fmtDaysWaiting } from "@/lib/people/dates";
import { PersonCardCloseButton } from "./PersonCardFrame";

export function PersonCardBody({ person }: { person: CardPerson }) {
  const workEmail = person.work_email ?? "";
  const hasWorkEmail = workEmail.length > 0;
  const hasPersonalEmail = person.showPersonalEmail && !!person.personal_email_for_display;
  const hasPhoneHref = !!person.phone_href;

  // Button layout per R-PP10:
  //   Hourly:   Call + Text (phone_href only; never printed)
  //   Salaried: Call + Email (work_email if present)
  const isHourly = !person.is_salaried;

  // Email target preference: work_email > personal_email_for_display
  // (personal is gated to non-salaried with no work_email only).
  const emailHref =
    hasWorkEmail ? `mailto:${workEmail}` :
    hasPersonalEmail ? `mailto:${person.personal_email_for_display}` :
    null;

  return (
    <>
      <header className="kf-pe-drawer__head">
        <div>
          <h3 id="pe-card-title">{person.display_name}</h3>
          <div className="kf-pe-drawer__chips">
            {person.is_site_leader ? <span className="kf-pill kf-pill--info">Site leader</span> : null}
            {person.is_regional_director ? <span className="kf-pill kf-pill--info">Regional</span> : null}
            {person.is_salaried ? <span className="kf-pill kf-pill--muted">Salaried</span> : <span className="kf-pill kf-pill--muted">Hourly</span>}
            {person.is_corp ? <span className="kf-pill kf-pill--muted">Corporate</span> : null}
          </div>
        </div>
        <PersonCardCloseButton />
      </header>

      <div className="kf-pe-drawer__body">
        {/* Contact buttons row. Hourly: Call + Text. Salaried: Call + Email. */}
        <div className="kf-pe-contact kf-pe-contact--2">
          {hasPhoneHref ? (
            <a className="kf-btn kf-btn--line" href={`tel:${person.phone_href}`}>
              <Phone size={14} strokeWidth={1.5} aria-hidden />
              <span>Call</span>
            </a>
          ) : (
            <span className="kf-btn kf-btn--line kf-pe-disabled" aria-disabled="true">
              <Phone size={14} strokeWidth={1.5} aria-hidden />
              <span>Call</span>
            </span>
          )}
          {isHourly ? (
            hasPhoneHref ? (
              <a className="kf-btn kf-btn--line" href={`sms:${person.phone_href}`}>
                <MessageCircle size={14} strokeWidth={1.5} aria-hidden />
                <span>Text</span>
              </a>
            ) : (
              <span className="kf-btn kf-btn--line kf-pe-disabled" aria-disabled="true">
                <MessageCircle size={14} strokeWidth={1.5} aria-hidden />
                <span>Text</span>
              </span>
            )
          ) : (
            emailHref ? (
              <a className="kf-btn kf-btn--line" href={emailHref}>
                <Mail size={14} strokeWidth={1.5} aria-hidden />
                <span>Email</span>
              </a>
            ) : (
              <span className="kf-btn kf-btn--line kf-pe-disabled" aria-disabled="true">
                <Mail size={14} strokeWidth={1.5} aria-hidden />
                <span>Email</span>
              </span>
            )
          )}
        </div>

        {/* Waiting state (if any). */}
        {person.waiting ? (
          <section className="kf-pe-waiting" aria-label="Waiting on a decision">
            <b>Pending - {fmtDaysWaiting(person.waiting.submitted_at)}</b>
            <span>
              {person.waiting.module.toUpperCase()}
              {person.waiting.action_type ? `: ${person.waiting.action_type}` : ""}
            </span>
            {person.waiting.submitter_name ? (
              <small>Sent {fmtFull(person.waiting.submitted_at)} by {person.waiting.submitter_name}</small>
            ) : (
              <small>Sent {fmtFull(person.waiting.submitted_at)}</small>
            )}
          </section>
        ) : null}

        {/* KV list. Role / Site / Reports to / Started / email / phone. */}
        <dl className="kf-pe-kvlist" aria-label="Details">
          <div className="kf-pe-kvlist__row">
            <dt>Role</dt>
            <dd>{person.title || "-"}</dd>
          </div>
          <div className="kf-pe-kvlist__row">
            <dt>Site</dt>
            <dd>
              {person.account_key}
              {person.account_region ? <small>{person.account_region}</small> : null}
            </dd>
          </div>
          <div className="kf-pe-kvlist__row">
            <dt>Reports to</dt>
            {/* Pin 4: name only, no link, no card trigger. */}
            <dd>{person.manager_name || "-"}</dd>
          </div>
          {person.started_full ? (
            <div className="kf-pe-kvlist__row">
              <dt>Started</dt>
              <dd>
                {person.started_full}
                {person.tenure_line ? <small>{person.tenure_line}</small> : null}
                {person.anniversary_line ? <small>{person.anniversary_line}</small> : null}
              </dd>
            </div>
          ) : null}
          {/* Email: work_email shown for anyone who has one; personal_email
             only when no work_email AND not salaried (R-PP10 enforced in
             src/lib/people/contact.ts). */}
          {hasWorkEmail ? (
            <div className="kf-pe-kvlist__row">
              <dt>Email</dt>
              <dd>{workEmail}</dd>
            </div>
          ) : hasPersonalEmail ? (
            <div className="kf-pe-kvlist__row">
              <dt>Email</dt>
              <dd>{person.personal_email_for_display}</dd>
            </div>
          ) : null}
          {/* Phone: salaried only - printed. Hourly phone never renders as
             text; it lives only inside tel:/sms: hrefs above. */}
          {person.phone_for_display ? (
            <div className="kf-pe-kvlist__row">
              <dt>Phone</dt>
              <dd>{person.phone_for_display}</dd>
            </div>
          ) : null}
        </dl>

        {/* History (R-PP54). Hidden when historyVisible is false. */}
        {person.historyVisible ? (
          <section aria-label="History this year">
            <h4 className="kf-pe-hist__h">History this year</h4>
            {person.history.length === 0 ? (
              <p className="kf-pe-hist__none">No completed requests this year.</p>
            ) : (
              <ul className="kf-pe-hist">
                {person.history.slice(0, 5).map((h) => (
                  <li key={h.id}>
                    <span className="kf-pe-hist__what">{h.action}</span>
                    <span className="kf-pe-hist__sub">
                      {h.status_display}{h.submitter_name ? ` - ${h.submitter_name}` : ""}
                    </span>
                    <time className="kf-pe-hist__time" dateTime={h.date} title={h.dateLong}>
                      {fmtShort(h.date)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
            {person.history.length > 5 ? (
              <span className="kf-pe-hist__more">See all {person.history.length}</span>
            ) : null}
          </section>
        ) : null}
      </div>

      {/* Two card buttons - inert in T2 per prompt. Chef floor = no --sm. */}
      <footer className="kf-pe-drawer__foot">
        <span className="kf-btn kf-btn--line kf-pe-disabled" aria-disabled="true">
          <span>PAF for this person</span>
        </span>
        <span className="kf-btn kf-btn--primary kf-pe-disabled" aria-disabled="true">
          <span>New request</span>
        </span>
        <span className="kf-pe-foot__cap">Coming with its own build step</span>
      </footer>
    </>
  );
}
