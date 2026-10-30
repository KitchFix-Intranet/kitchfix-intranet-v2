// /academy/done - the record. Server component. loadRecords(email).
// Receipts newest first (loader order), Waived section hidden when
// empty (R-AC25), topbar carries the Download action (see
// @topbar/academy/done).

import { requireAppAccess } from "@/lib/gate";
import { loadRecords } from "@/lib/academy/records";
import { IdentBand } from "@/components/ui/IdentBand";
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
      <div className="kf-sheet">
        <IdentBand
          eyebrow="Your record"
          title="Record unavailable"
          kick="Couldn't read your record."
          status="failed"
          pageName="Done"
        />
      </div>
    );
  }

  const { viewer, mine } = result;
  const name = firstName(viewer.displayName);
  const sigs = mine.signatures;
  const waived = mine.waived;

  const title = recordTitle(sigs.length, name);
  const kick = sigs.length === 0
    ? "Nothing to show yet. Receipts will appear here after you sign."
    : "Permanent. Certificates and waivers, with the reason.";

  return (
    <div className="kf-sheet">
      <IdentBand
        eyebrow="Your record"
        title={title}
        kick={kick.length > 60 ? kick.slice(0, 60) : kick}
      />

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
        <section aria-label="Signatures" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-4)" }}>
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
            <h3 style={{ color: "var(--sp-navy)", fontSize: "var(--sp-t-h3)" }}>
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
  );
}
