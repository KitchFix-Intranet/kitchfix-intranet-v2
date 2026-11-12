// Person-card body. Server component - the R-PP10 contact rule is
// enforced before this file runs (see src/lib/people/contact.ts
// toCardPerson). This file only renders the already-sanitised
// CardPerson shape. Phone digits reach the DOM only through tel:
// and sms: href attributes.
//
// T2.2 (2026-11-12). Matches the approved render's card:
//   - Eyebrow: club name (accounts.name).
//   - Title: person's name + " (you)" when the viewer is on their
//     own card.
//   - Chips row: pending pill (when waiting) + one skew tag
//     (Site leader / Salaried / Hourly) + contact buttons.
//   - Contact buttons: Hourly gets Call, Text, Email; Salaried gets
//     Call, Email. Email is only enabled when R-PP10 lets the
//     viewer see an email for that person.
//   - Body: shared `.kf-kv` list with Role, Site, Reports to,
//     Started (one line), Work/Personal email, Phone (salaried).
//   - "In flight" section (R-PP54 visibility) listing pending items.
//   - History: shared `.kf-pe-sechead` + a short "Nothing sent"
//     fallback.
//   - Footer: caption + Start a PAF (inert) + Report an incident
//     (inert) + Close (phone only).

import { Phone, MessageCircle, Mail } from "lucide-react";
import type { CardPerson, InFlightRow } from "@/lib/people/types";
import { fmtShort } from "@/lib/people/dates";
import { PersonCardCloseButton, PersonCardFooterClose } from "./PersonCardFrame";

// ONE skew tag per the render:
//   - site_leader   -> "Site leader"
//   - salaried      -> "Salaried" (not for corporate)
//   - hourly        -> "Hourly"
//   - corporate     -> nothing
function tagLabel(p: CardPerson): string | null {
  if (p.is_site_leader) return "Site leader";
  if (p.is_corp) return null;
  if (p.is_salaried) return "Salaried";
  return "Hourly";
}

function InFlightTable({ rows }: { rows: InFlightRow[] }) {
  return (
    <div className="kf-pe-tablecard">
      <table className="kf-pe-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="kf-pe-row">
              <td className="kf-pe-what">
                <span className={`kf-pe-kind${r.kind === "incident" ? " kf-pe-kind--incident" : ""}`} aria-hidden>
                  {r.kind === "incident" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" />
                      <path d="M12 9v4M12 17h.01" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="8" y="2" width="8" height="4" rx="1" />
                      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                      <path d="M9 12h6M9 16h6" />
                    </svg>
                  )}
                </span>
                <span className="kf-pe-what__text">
                  <b title={r.label}>{r.label}</b>
                  <small title={r.submitter_name ? `sent by ${r.submitter_name}` : `sent ${r.sent_short}`}>
                    {r.submitter_name ? `sent by ${r.submitter_name} · ${r.sent_short}` : `sent ${r.sent_short}`}
                  </small>
                </span>
              </td>
              <td className={`kf-pe-when${r.late ? " is-late" : ""}`}>
                <time>{r.wait_days}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PersonCardBody({ person }: { person: CardPerson }) {
  const workEmail = (person.work_email ?? "").trim();
  const hasWorkEmail = workEmail.length > 0;
  const hasPersonalEmail = person.showPersonalEmail && !!person.personal_email_for_display;
  const emailHref =
    hasWorkEmail ? `mailto:${workEmail}` :
    hasPersonalEmail ? `mailto:${person.personal_email_for_display}` :
    null;

  const hasPhoneHref = !!person.phone_href;
  const isHourly = !person.is_salaried;

  const tag = tagLabel(person);
  const titleId = `pe-card-title-${person.worker_id}`;

  return (
    <>
      <header className="kf-pe-drawer__head">
        <div>
          <span className="kf-eyebrow kf-eyebrow--plain">{person.eyebrow}</span>
          <h3 id={titleId}>{person.display_name}{person.title_suffix}</h3>
          <div className="kf-pe-drawer__chips">
            {person.waiting_count > 0 ? (
              <span className="kf-pill kf-pill--info kf-pe-pill">
                <i className="kf-pe-dot" aria-hidden />
                Pending
              </span>
            ) : null}
            {tag ? <span className="kf-skew-tag"><span>{tag}</span></span> : null}
          </div>
          <div className="kf-pe-contact">
            {hasPhoneHref ? (
              <a className="kf-btn kf-btn--ghost" href={`tel:${person.phone_href}`}>
                <Phone size={16} strokeWidth={1.5} aria-hidden />
                <span>Call</span>
              </a>
            ) : (
              <span className="kf-btn kf-btn--ghost kf-pe-disabled" aria-disabled="true">
                <Phone size={16} strokeWidth={1.5} aria-hidden />
                <span>Call</span>
              </span>
            )}
            {isHourly ? (
              hasPhoneHref ? (
                <a className="kf-btn kf-btn--ghost" href={`sms:${person.phone_href}`}>
                  <MessageCircle size={16} strokeWidth={1.5} aria-hidden />
                  <span>Text</span>
                </a>
              ) : (
                <span className="kf-btn kf-btn--ghost kf-pe-disabled" aria-disabled="true">
                  <MessageCircle size={16} strokeWidth={1.5} aria-hidden />
                  <span>Text</span>
                </span>
              )
            ) : null}
            {emailHref ? (
              <a className="kf-btn kf-btn--ghost" href={emailHref}>
                <Mail size={16} strokeWidth={1.5} aria-hidden />
                <span>Email</span>
              </a>
            ) : (
              <span className="kf-btn kf-btn--ghost kf-pe-disabled" aria-disabled="true">
                <Mail size={16} strokeWidth={1.5} aria-hidden />
                <span>Email</span>
              </span>
            )}
          </div>
        </div>
        <PersonCardCloseButton />
      </header>

      <div className="kf-pe-drawer__body">
        {/* Shared .kf-kv list (components.css). Each row is a
         * structural div with dt/dd. T2.2: labels vary ("Work email"
         * vs "Personal email") and the Started value is a one-liner. */}
        <dl className="kf-kv" aria-label="Details">
          <div>
            <dt>Role</dt>
            <dd>{person.role_display}</dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{person.site_display}</dd>
          </div>
          <div>
            <dt>Reports to</dt>
            {/* Pin 4: name only, no link, no card trigger. */}
            <dd>{person.manager_name || "-"}</dd>
          </div>
          {person.started_line ? (
            <div>
              <dt>Started</dt>
              <dd>{person.started_line}</dd>
            </div>
          ) : null}
          {person.email_label && person.email_for_display ? (
            <div>
              <dt>{person.email_label}</dt>
              <dd>{person.email_for_display}</dd>
            </div>
          ) : null}
          {person.phone_for_display ? (
            <div>
              <dt>Phone</dt>
              <dd>{person.phone_for_display}</dd>
            </div>
          ) : null}
        </dl>

        {/* In flight. Same visibility rule as History (R-PP54). A
         * viewer who may not open the request sees the count only. */}
        {person.waiting_count > 0 ? (
          <>
            <div className="kf-pe-sechead">
              <h3>In flight</h3>
              <span className="kf-pe-sechead__meta">
                {person.inFlightCount} pending
              </span>
            </div>
            {person.inFlightVisible && person.inFlightRows.length > 0 ? (
              <InFlightTable rows={person.inFlightRows} />
            ) : (
              /* T2.2.1: one note per pending request. State only -
               * what it is, who sent it, how long it has waited, and
               * who may open it. No amounts, no notes, no other
               * fields. See src/lib/people/loadPerson.ts. */
              <ul className="kf-pe-noteslist">
                {person.inFlightNotes.map((note, i) => (
                  <li key={i} className="kf-pe-muted kf-pe-small">{note}</li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {/* History (R-PP54). When not visible, the section is hidden
         * entirely (the "waiting state" has already been shown above). */}
        {person.historyVisible ? (
          <>
            <div className="kf-pe-sechead">
              <h3>History</h3>
            </div>
            {person.history.length === 0 ? (
              <p className="kf-pe-muted kf-pe-small">Nothing sent for this person this year.</p>
            ) : (
              <div className="kf-pe-tablecard">
                <table className="kf-pe-table">
                  <tbody>
                    {person.history.slice(0, 5).map((h) => (
                      <tr key={h.id} className="kf-pe-row">
                        <td className="kf-pe-what">
                          <span className="kf-pe-what__text">
                            <b title={h.action}>{h.action}</b>
                            <small>
                              {h.status_display}
                              {h.submitter_name ? ` · ${h.submitter_name}` : ""}
                            </small>
                          </span>
                        </td>
                        <td className="kf-pe-when">
                          <time dateTime={h.date} title={h.dateLong}>{fmtShort(h.date)}</time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {person.history.length > 5 ? (
                  <p className="kf-pe-hist__more">
                    See all {person.history.length}
                  </p>
                ) : null}
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Footer: caption + Start a PAF (inert) + Report an incident
       * (inert) + Close (phone only). No "New request". */}
      <footer className="kf-pe-drawer__foot">
        <span className="kf-pe-foot__cap">
          PAF: A change to their role, pay or hours, or something to pay back.
        </span>
        <span className="kf-btn kf-btn--primary kf-pe-disabled" aria-disabled="true">
          <span>Start a PAF</span>
        </span>
        <span className="kf-btn kf-btn--ghost kf-pe-disabled" aria-disabled="true">
          <span>Report an incident</span>
        </span>
        <PersonCardFooterClose />
      </footer>
    </>
  );
}
