// /library/suggestions/mine - "Your suggestions".
//
// Any signed-in person the Library gate lets in sees only their
// own notes, newest first. Read only. The server decides whose
// notes these are from the signed-in session - no email, no id in
// the address, no reporter_email in the request.
//
// A note on a document the viewer can no longer read by L1's rule
// shows the document's number only; no title, no link.

import Link from "next/link";
import { requireAppAccess } from "@/lib/gate";
import { listMineForEmail } from "@/lib/academy/suggestions";
import { fmtDate } from "@/lib/fmt";
import "@/components/library/library.css";

export default async function Page() {
  const { email } = await requireAppAccess("/library/suggestions/mine");
  const list = await listMineForEmail(email);
  const rows = list.ok ? list.rows : [];

  if (!list.ok) {
    return (
      <section className="kf-lb-sugs" aria-label="Your suggestions">
        <header className="kf-lb-sugs__head">
          <h1 className="kf-lb-sugs__h1">Your suggestions</h1>
        </header>
        <div className="kf-error" role="alert">
          <div className="kf-error__title">Could not read the list</div>
          <div className="kf-error__body">
            The server did not return an answer. Try again in a moment.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="kf-lb-sugs" aria-label="Your suggestions">
      <header className="kf-lb-sugs__head">
        <h1 className="kf-lb-sugs__h1">Your suggestions</h1>
        <p className="kf-lb-sugs__sub">
          Every note you have sent, newest first. The owner handles these
          on their side.
        </p>
      </header>

      {rows.length === 0 ? (
        <section
          className="kf-empty"
          role="status"
          aria-label="No suggestions yet"
        >
          <div className="kf-empty__icon" aria-hidden />
          <div>
            <h3 className="kf-empty__title">No suggestions yet</h3>
            <p className="kf-empty__body">
              Notes you send from a document land here. Open a document and
              press Suggest an edit to send one.
            </p>
          </div>
          <Link href="/library" className="kf-btn kf-btn--primary">
            Go to the Library
          </Link>
        </section>
      ) : (
        <div className="kf-lb-sugs__list">
          {rows.map((r) => {
            const state = r.screen_state;
            const stateLabel =
              state === "open"
                ? "Open"
                : state === "accepted"
                ? "Accepted"
                : state === "done"
                ? "Done"
                : state === "declined"
                ? "Declined"
                : "Open";
            const partLabel = r.section_title ?? "The whole document";
            return (
              <article
                key={r.id}
                className="kf-lb-sug-row"
                aria-label={`Your note on ${r.doc_id}`}
              >
                <header className="kf-lb-sug-row__head">
                  <span className="kf-lb-sug-row__id">{r.doc_id}</span>
                  {r.may_read && r.doc_title ? (
                    <Link
                      href={`/library/${r.doc_id}${
                        r.section_key ? `#${r.section_key}` : ""
                      }`}
                      className="kf-lb-sug-row__title kf-lb-sug-row__title--link"
                      prefetch={false}
                    >
                      {r.doc_title}
                    </Link>
                  ) : null}
                  <span className="kf-lb-sug-row__meta">
                    Part: <strong>{partLabel}</strong>
                    {r.doc_version ? ` - v${r.doc_version}` : ""}
                  </span>
                  <span className={`kf-pill kf-pill--${state}`}>{stateLabel}</span>
                </header>
                <p className="kf-lb-sug-row__body">{r.issue_text}</p>
                {r.suggested_text ? (
                  <section
                    className="kf-lb-sug-row__wordblock"
                    aria-label="Your wording"
                  >
                    <span className="kf-lb-field__l">Your wording</span>
                    <pre className="kf-lb-sug-row__pre">{r.suggested_text}</pre>
                  </section>
                ) : null}
                {state === "declined" && r.handled_note ? (
                  <section
                    className="kf-lb-sug-row__reason"
                    aria-label="Reason given"
                  >
                    <span className="kf-lb-field__l">Reason</span>
                    <p>{r.handled_note}</p>
                  </section>
                ) : null}
                <footer className="kf-lb-sug-row__foot">
                  <span className="kf-lb-sug-row__meta">
                    Sent {r.created_at ? fmtDate(r.created_at, "time") : ""}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
