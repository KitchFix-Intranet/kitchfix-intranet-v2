// Record drawer body (server component). Reads a pre-rendered
// RecordView from loadRecord.ts - no payload touches this file.
//
// Shape mirrors the render's `rec-inbox` aside:
//   header: eyebrow, title, status chip
//   body: .kf-pe-kvlist > .kf-kv with the detail pairs, then the
//         sender's note, then "What happened" as a ledger
//   footer: Start a PAF (inert), Report an incident (inert), Close
//           (phone). Later trains will add Withdraw, Nudge,
//           Fix-and-resend. Those are rendered as disabled in T3
//           ONLY when the state calls for them - a decided record
//           carries no Withdraw placeholder.

import type { RecordView } from "@/lib/people/loadRecord";
import { PersonCardCloseButton, PersonCardFooterClose } from "./PersonCardFrame";

function StatusPillInline({ status_code, status_display }: { status_code: RecordView["status_code"]; status_display: string }) {
  const tone =
    status_code === "Complete" ? "kf-pill--good" :
    status_code === "Rejected" ? "kf-pill--block" :
    status_code === "Pending" ? "kf-pill--info" :
    "kf-pill--muted";
  return <span className={`kf-pill ${tone} kf-pe-pill`}>{status_display}</span>;
}

export function RecordDrawerBody({ record }: { record: RecordView }) {
  const titleId = `pe-rec-title-${record.id}`;
  return (
    <>
      <header className="kf-pe-drawer__head">
        <div>
          <span className="kf-eyebrow kf-eyebrow--plain">{record.eyebrow}</span>
          <h3 id={titleId}>{record.title}</h3>
          <div className="kf-pe-drawer__chips">
            <StatusPillInline status_code={record.status_code} status_display={record.status_display} />
          </div>
        </div>
        <PersonCardCloseButton />
      </header>

      <div className="kf-pe-drawer__body">
        <div className="kf-pe-kvlist">
          <dl className="kf-kv" aria-label="Details">
            {record.detail.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {record.status_code === "Rejected" && record.rejection_reason ? (
          <div className="kf-pe-note kf-pe-note--warn">
            <b>Rejected</b> {record.rejection_reason}
          </div>
        ) : null}

        {record.sender_note ? (
          <div className="kf-pe-note">
            <b>Sender's note</b> {record.sender_note}
          </div>
        ) : null}

        <div className="kf-pe-sechead">
          <h3>What happened</h3>
        </div>
        {record.ledger.length === 0 ? (
          <p className="kf-pe-muted kf-pe-small">Nothing recorded yet.</p>
        ) : (
          <ol className="kf-pe-ledger">
            {record.ledger.map((e, i) => (
              <li key={i} className={`kf-pe-ledger__row kf-pe-ledger__row--${e.tone}`}>
                <i aria-hidden />
                <span className="kf-pe-ledger__what">{e.what}</span>
                {e.means ? <span className="kf-pe-ledger__means">{e.means}</span> : null}
                <time>{e.when}</time>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* T3.1 fix 2 (2026-11-13). A record is not a person. The
       * footer carries only the read-only caption plus Close on
       * phone. "Start a PAF" / "Report an incident" belong to the
       * person card, not here. */}
      <footer className="kf-pe-drawer__foot">
        <span className="kf-pe-foot__cap">
          Read-only in this release. Withdraw, Nudge and Fix-and-resend arrive with the forms.
        </span>
        <PersonCardFooterClose />
      </footer>
    </>
  );
}
