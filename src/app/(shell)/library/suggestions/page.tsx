// /library/suggestions - owner-only. Open reader notes, newest
// first; two actions each (Used / No change) that close the row.
// The office's fuller queue (reading the wording against the doc,
// taking it into a draft) is a later train.

import Link from "next/link";
import { requireOwnerPage } from "@/lib/gate";
import { listOpenSuggestions } from "@/lib/academy/suggestions";
import { SuggestionRow } from "@/components/library/SuggestionRow";
import "@/components/library/library.css";

export default async function Page() {
  await requireOwnerPage();
  const list = await listOpenSuggestions();
  const rows = list.ok ? list.rows : [];
  return (
    <section className="kf-lb-sugs" aria-label="Open suggestions">
      <header className="kf-lb-sugs__head">
        <h1 className="kf-lb-sugs__h1">Suggestions</h1>
        <p className="kf-lb-sugs__sub">
          Open reader notes, newest first. Pressing Used or No change closes
          the note and takes it off this list.
        </p>
      </header>
      {!list.ok ? (
        <div className="kf-error" role="alert">
          <div className="kf-error__title">Could not read the list</div>
          <div className="kf-error__body">
            The server did not return an answer. Try again in a moment.
          </div>
        </div>
      ) : rows.length === 0 ? (
        <section className="kf-empty" role="status" aria-label="No open suggestions">
          <div className="kf-empty__icon" aria-hidden />
          <div>
            <h3 className="kf-empty__title">Nothing open</h3>
            <p className="kf-empty__body">
              No reader notes are waiting. New ones land here when they
              come in.
            </p>
          </div>
          <Link href="/library" className="kf-btn kf-btn--primary">
            Go to the Library
          </Link>
        </section>
      ) : (
        <div className="kf-lb-sugs__list">
          {rows.map((r) => (
            <SuggestionRow key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}
