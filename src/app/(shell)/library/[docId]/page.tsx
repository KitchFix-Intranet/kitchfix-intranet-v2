// /library/[docId] - Library L3: the document page.
//
// A document is one thing, so the page has no navy band: it opens
// with the document. On wide widths three columns:
//   left:   Contents (scroll-spy, moves focus to the section's h2)
//   middle: article
//   right:  About (version, published date, owner, approver)
//
// Below the wide threshold the right About column stacks above the
// article, and the top bar's Details control opens a panel with the
// fuller fact set. The left Contents column folds into a <details>
// above the article on phones, and the shelf-jump strip on the
// bookcase is NOT carried here - a document's contents list is its
// own thing.
//
// R-AC26 holds: no "trains you" pill, no "Open in Academy" link, no
// signature line, no Academy marker on this page.
//
// Read-only. The server renders the HTML (produced by v1's
// automation) and injects stable ids on every heading via the
// shared outline helper. Cross-document numbers in prose are
// resolved server-side: a number the viewer may read becomes an
// anchor to /library/<id>; a number the viewer may not read is
// plain text with no hint.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAppAccess } from "@/lib/gate";
import { loadDocument } from "@/lib/academy/document";
import { humanizeDocClass } from "@/lib/academy/docClass";
import { fmtDate } from "@/lib/fmt";
import { buildOutline, stripLeadingTitleH1, wireCrossDocLinks, injectSectionEndControls } from "@/lib/academy/outline";
import { DocNav } from "@/components/library/DocNav";
import { DocControlsIsland } from "@/components/library/DocControlsIsland";
import { DocEnd } from "@/components/library/DocEnd";
import { hasOwnSuggestions } from "@/lib/academy/suggestions";
import "@/components/library/library.css";

export default async function Page({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = await params;
  const { email } = await requireAppAccess(`/library/${docId}`);

  const result = await loadDocument(email, docId);

  if (!result.ok) {
    if (result.status === 403) {
      return (
        <div className="kf-lb-restricted">
          <section
            className="kf-empty"
            role="status"
            aria-label="Kept for management and above"
          >
            <div className="kf-empty__icon" aria-hidden />
            <div>
              <h1 className="kf-empty__title">
                {result.docId} is kept for management and above
              </h1>
              <p className="kf-empty__body">
                It is not on your shelves. If you need something from it, ask
                your regional director.
              </p>
            </div>
            <Link href="/library" className="kf-btn kf-btn--primary">
              Go to the Library
            </Link>
          </section>
        </div>
      );
    }
    notFound();
  }

  const doc = result.doc;
  const bodyHtml = stripLeadingTitleH1(result.content_html ?? "", doc.title || doc.id);
  const { augmented, outline } = buildOutline(bodyHtml || null);
  const linkedHtml = augmented ? await wireCrossDocLinks(augmented, doc.id, email) : augmented;
  // After cross-doc links, insert the per-section "Suggest an edit"
  // controls. The order matters: wireCrossDocLinks walks the body
  // text; we want the end-of-section controls to be added AFTER
  // that pass so the button HTML is not itself rewritten.
  const bodyWithSectionEnds = linkedHtml ? injectSectionEndControls(linkedHtml, outline) : linkedHtml;
  // Server-side check used only to decide whether to show the
  // quiet "Your suggestions" link at the end of the document. The
  // viewer never sees anyone else's note from this signal.
  const viewerHasNotes = await hasOwnSuggestions(email);
  const versionLabel = doc.version != null ? `v${doc.version}` : null;
  const classLabel = humanizeDocClass(doc.doc_class);

  // The Spanish sibling link: only when the server knows a readable
  // ES (or EN, if this doc is -ES) sibling exists. The loader has
  // already filtered restricted siblings out.
  const docIsES = doc.id.endsWith("-ES");
  const spanishHref = result.languages.hasEs && !docIsES ? `/library/${doc.id}-ES` : null;
  const englishHref =
    docIsES && result.languages.hasEn ? `/library/${doc.id.replace(/-ES$/, "")}` : null;

  // Facts handed to the DocControlsIsland. Version is a plain string
  // so Details can show "v3" the same way the right column does.
  const facts = {
    id: doc.id,
    title: doc.title,
    version: versionLabel,
    status: doc.status || "-",
    owner: doc.owner,
    approver: doc.approver,
    kind: classLabel || "Document",
    shelf: doc.shelf,
    effective_date: doc.effective_date ? fmtDate(doc.effective_date, "short") : null,
    last_reviewed: doc.last_reviewed ? fmtDate(doc.last_reviewed, "short") : null,
    next_review: doc.next_review ? fmtDate(doc.next_review, "short") : null,
    hasEn: result.languages.hasEn,
    hasEs: result.languages.hasEs,
    spanishHref,
  };

  return (
    <div className="kf-lb-doc">
      <aside className="kf-lb-doc__side" aria-label="Document rail">
        {outline.length > 0 ? <DocNav outline={outline} /> : null}
      </aside>

      <article className="kf-lb-doc__art" aria-label={doc.title}>
        <div className="kf-lb-doc__id-row">
          <span className="kf-cls kf-cls--id">{doc.id}</span>
          {classLabel ? <span className="kf-cls">{classLabel}</span> : null}
          {doc.status ? (
            <span className="kf-cls kf-cls--live">
              {doc.status}
              {versionLabel ? ` - ${versionLabel}` : ""}
            </span>
          ) : null}
          {result.languages.hasEn ? <span className="kf-cls">EN</span> : null}
          {result.languages.hasEs ? <span className="kf-cls kf-cls--es">ES</span> : null}
        </div>
        <h1 className="kf-lb-doc__title">{doc.title}</h1>
        {doc.card_line ? <p className="kf-lb-doc__lede">{doc.card_line}</p> : null}
        {spanishHref ? (
          <p className="kf-lb-doc__lang">
            <Link href={spanishHref} prefetch={false}>
              Leer en espanol
            </Link>
          </p>
        ) : null}
        {englishHref ? (
          <p className="kf-lb-doc__lang">
            <Link href={englishHref} prefetch={false}>
              Read in English
            </Link>
          </p>
        ) : null}
        {result.emptyContent ? (
          <section className="kf-empty" aria-label="No content">
            <div className="kf-empty__icon" aria-hidden />
            <div>
              <h3 className="kf-empty__title">This document has no readable content yet</h3>
              <p className="kf-empty__body">
                The record exists; the readable version has not been written. If
                this is a non-English posting, the Spanish train will surface it.
              </p>
            </div>
            <Link href="/library" className="kf-btn kf-btn--primary">
              Back to Library
            </Link>
          </section>
        ) : (
          <div
            className="kf-docbody"
            dangerouslySetInnerHTML={{ __html: bodyWithSectionEnds }}
          />
        )}
        <DocEnd
          docId={doc.id}
          docTitle={doc.title}
          ownerName={doc.owner}
          showYourSuggestions={viewerHasNotes}
        />
      </article>

      <aside className="kf-lb-doc__about" aria-label="About this document">
        <section className="kf-lb-doc__about-card">
          <header>
            <span className="kf-lb-doc__about-eyebrow">About</span>
          </header>
          <dl className="kf-lb-doc__about-kv">
            <dt>Version</dt>
            <dd>{versionLabel ?? "-"}</dd>
            {doc.effective_date ? (
              <>
                <dt>Published</dt>
                <dd>{fmtDate(doc.effective_date, "short")}</dd>
              </>
            ) : null}
            {doc.owner ? (
              <>
                <dt>Owner</dt>
                <dd>{doc.owner}</dd>
              </>
            ) : null}
            {doc.approver ? (
              <>
                <dt>Approver</dt>
                <dd>{doc.approver}</dd>
              </>
            ) : null}
          </dl>
        </section>
      </aside>

      <DocControlsIsland
        docId={doc.id}
        docTitle={doc.title}
        outline={outline}
        facts={facts}
      />
    </div>
  );
}
