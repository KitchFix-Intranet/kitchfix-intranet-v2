// /academy/done - the record. V7 structure. Server component.
//
// Band stretches the full canvas and carries facts: Signed / Waived /
// Minutes read + Download. The band is the same navy identity band as
// every other learner surface - the light-on-light variant is retired
// (review P1 #4). Below the band, a two-column frame with receipts in
// the primary column and a Your-year / What-a-certificate-proves rail
// to the right (stacks at <=1180).
//
// Receipts newest first, Waived section renders only when there is
// something waived.

import { requireAppAccess } from "@/lib/gate";
import { loadRecords } from "@/lib/academy/records";
import { AcademyBand } from "@/components/academy/AcademyBand";
import { Receipt } from "@/components/academy/Receipt";
import { fmtDate } from "@/lib/fmt";
import "@/components/academy/academy.css";

function firstName(displayName: string | null): string | null {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
}

function recordTitle(n: number, name: string | null): string {
  if (n === 0) return name ? `No signatures yet, ${name}` : "No signatures yet";
  const noun = n === 1 ? "signature" : "signatures";
  const num = n === 1 ? "One" : String(n);
  return `${num} ${noun} on record`;
}

export default async function Page() {
  const { email } = await requireAppAccess("/academy/done");
  const result = await loadRecords(email);

  if (!result.ok) {
    return (
      <div className="kf-academy">
        <AcademyBand
          eyebrow="Your record"
          title="Record unavailable"
          kick="Couldn't read your record."
        />
      </div>
    );
  }

  const { viewer, mine } = result;
  const name = firstName(viewer.displayName);
  const sigs = mine.signatures;
  const waived = mine.waived;

  const title = recordTitle(sigs.length, name);
  const kick =
    sigs.length === 0
      ? "Nothing to show yet. Receipts will appear here after you sign."
      : "Permanent. Certificates and waivers, with the reason.";

  // Facts for the band. "Minutes read" sums the Minutes column from
  // the signatures the records loader returns.
  const minutesRead = sigs.reduce((acc, s) => acc + (s.minutes || 0), 0);

  // "Your year" rail numbers: first signature, latest, next due.
  // next_due_at comes from mine.outstanding (earliest due_date among
  // open requirements).
  const first = sigs.length ? sigs[sigs.length - 1] : null;
  const latest = sigs.length ? sigs[0] : null;
  const nextDue = mine.outstanding
    .filter((o) => o.due_date != null)
    .sort((a, b) => (a.due_date as string).localeCompare(b.due_date as string))[0]?.due_date ?? null;

  return (
    <div className="kf-academy">
      <div className="kf-academy__wash" aria-hidden />
      <AcademyBand
        eyebrow="Done"
        title={title}
        kick={kick.length > 60 ? kick.slice(0, 60) : kick}
        facts={[
          { label: "Signed", value: sigs.length },
          { label: "Waived", value: waived.length },
          { label: "Minutes read", value: minutesRead },
        ]}
        cta={sigs.length > 0 ? { label: "Download", href: "/api/academy/records" } : undefined}
      />
      <div className="kf-academy__frame">
        <div className="kf-academy__main">
          {sigs.length === 0 ? (
            <section className="kf-empty" aria-label="No signatures">
              <div className="kf-empty__icon" aria-hidden>-</div>
              <div>
                <h3 className="kf-empty__title">Nothing on record yet</h3>
                <p className="kf-empty__body">
                  When you sign your first document, the certificate lands here.
                </p>
              </div>
            </section>
          ) : (
            <section
              aria-label="Signatures"
              style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-4)" }}
            >
              {sigs.map((s) => (
                <Receipt
                  key={String(s.attestation_id)}
                  size="full"
                  docTitle={s.doc.title}
                  moduleLabel={s.module.source_section ?? s.module.key}
                  signedAt={s.signed_at}
                  certificateSerial={s.certificate_serial}
                  docVersion={s.doc_version}
                  certificateHref={s.certificate_href}
                />
              ))}
            </section>
          )}

          {waived.length > 0 ? (
            <section className="kf-waived" aria-label="Waived">
              <header className="kf-section-head">
                <span className="kf-eyebrow kf-eyebrow--plain">Waived</span>
                <h3 style={{ color: "var(--sp-navy)", fontSize: "var(--sp-t-item)" }}>
                  {waived.length === 1 ? "One waived item" : `${waived.length} waived items`}
                </h3>
              </header>
              {waived.map((w) => (
                <article key={String(w.requirement_id)} className="kf-waived__row">
                  <h4 className="kf-waived__title">{w.doc.title}</h4>
                  <p className="kf-waived__meta">
                    Waived {w.waived_at ? fmtDate(w.waived_at, "short") : "-"}
                    {w.waived_by ? ` by ${w.waived_by}` : ""}
                    {w.cycle_label ? ` - ${w.cycle_label}` : ""}
                  </p>
                  {w.waive_reason ? <p className="kf-waived__reason">{w.waive_reason}</p> : null}
                </article>
              ))}
            </section>
          ) : null}

          <p className="kf-sheet-footer">
            Your record is permanent. Every signature, every waiver and every
            answer is kept as it happened. Download it any time.
          </p>
        </div>
        <aside className="kf-academy__rail" aria-label="Your year">
          <section className="kf-year-card">
            <h3 className="kf-year-card__title">Your year</h3>
            <div className="kf-year-row">
              <span>First</span>
              <span className="kf-year-row__value">
                {first?.signed_at ? fmtDate(first.signed_at, "short") : "-"}
              </span>
            </div>
            <div className="kf-year-row">
              <span>Latest</span>
              <span className="kf-year-row__value">
                {latest?.signed_at ? fmtDate(latest.signed_at, "short") : "-"}
              </span>
            </div>
            <div className="kf-year-row">
              <span>Next due</span>
              <span className="kf-year-row__value">
                {nextDue ? fmtDate(nextDue, "short") : "-"}
              </span>
            </div>
          </section>
          <section className="kf-rail-card" aria-label="What a certificate proves">
            <h3 className="kf-rail-card__title">What a certificate proves</h3>
            <p className="kf-rail-card__body">
              A certificate records what you read, which questions you
              answered, and the version you signed. It is permanent and
              never anonymous.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
