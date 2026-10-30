// /library/[docId] - F2 (V7). Two-column reading surface under
// STD-001 (R-AC27, R-AC28). Left rail = Contents (always-open <nav>
// via <DocNav>, scroll-spy) + About this document card. Right =
// the article as a free-scrolling .kf-docarticle, body under
// .kf-docbody (STD-001 type scale).
//
// R-AC26: no Academy linkage anywhere. The loader still computes
// trainsYou / openRequirementId; we deliberately ignore both and
// strip the "on your to-do list" / "Open in Academy" surfaces that
// were here before.
//
// READ-ONLY. No progress POST, no attempt, no attestation.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAppAccess } from "@/lib/gate";
import { loadDocument } from "@/lib/academy/document";
import { humanizeDocClass } from "@/lib/academy/docClass";
import { fmtDate } from "@/lib/fmt";
import { DocNav } from "@/components/library/DocNav";
import { PrintDocButton } from "@/components/library/PrintDocButton";
import "@/components/library/library.css";

const HEADING_RE = /<h([1-3])[^>]*>([^<]+)<\/h\1>/gi;

function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function slugAnchor(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Strip a stored <h1> that just repeats the document title. 7 docs
// today (FORM-004/005/007/008, REF-142, TPL-101/102) store their body
// opening with an H1 that duplicates the title; some sit at the very
// top, others follow a leading masthead paragraph. The chrome already
// renders the display-face title above the article, so without this
// strip STD-001's auto-numbered h1 rule would plant "SECTION 01" on a
// second copy of the title. Target the FIRST <h1> in the body; strip
// it only if its text matches the title. Any legitimate mid-document
// H1 that happens to repeat the title would get the same treatment,
// which is still the correct call (chrome already carries the title).
function stripLeadingTitleH1(html: string, title: string): string {
  if (!html) return html;
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
  const m = re.exec(html);
  if (!m) return html;
  const inner = m[1].replace(/<[^>]*>/g, "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm(inner) !== norm(title)) return html;
  return html.replace(re, "");
}

function buildOutline(html: string | null): {
  augmented: string;
  outline: Array<{ level: number; text: string; anchor: string }>;
} {
  if (!html) return { augmented: "", outline: [] };
  const outline: Array<{ level: number; text: string; anchor: string }> = [];
  const seen = new Map<string, number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(HEADING_RE.source, "gi");
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1]);
    const text = decodeEntities(m[2]).trim();
    const base = slugAnchor(text);
    let anchor = base;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) anchor = `${base}-${n}`;
    outline.push({ level, text, anchor });
  }
  let i = 0;
  const augmented = html.replace(HEADING_RE, (_match, lvl, inner) => {
    const row = outline[i];
    i += 1;
    if (!row) return _match;
    return `<h${lvl} id="${row.anchor}">${inner}</h${lvl}>`;
  });
  return { augmented, outline };
}

export default async function Page({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = await params;
  const { email } = await requireAppAccess(`/library/${docId}`);

  const result = await loadDocument(email, docId);

  if (!result.ok) {
    if (result.status === 404) notFound();
    notFound();
  }

  const doc = result.doc;
  // Strip a leading H1 that just repeats the title before parsing so
  // STD-001's "SECTION 01" counter lands on the first real section
  // instead of a duplicate title.
  const bodyHtml = stripLeadingTitleH1(result.content_html ?? "", doc.title || doc.id);
  const { augmented, outline } = buildOutline(bodyHtml || null);
  const versionLabel = doc.version != null ? `v${doc.version}` : null;
  const classLabel = humanizeDocClass(doc.doc_class);

  const languages: string[] = [];
  if (result.languages.hasEn) languages.push("English");
  if (result.languages.hasEs) languages.push("Spanish");

  return (
    <div className="kf-docpage">
      <aside className="kf-docside" aria-label="Document rail">
        {outline.length > 0 ? <DocNav outline={outline} /> : null}
        <section className="kf-docmeta" aria-label="About this document">
          <header className="kf-docmeta__head">
            <span className="kf-docmeta__eyebrow">About this document</span>
          </header>
          <dl className="kf-docmeta__kv">
            <dt>Number</dt>
            <dd className="kf-docmeta__mono">{doc.id}</dd>
            <dt>Kind</dt>
            <dd>{classLabel || "Document"}</dd>
            <dt>Version</dt>
            <dd>{versionLabel ?? "-"}</dd>
            <dt>Status</dt>
            <dd>{doc.status || "-"}</dd>
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
            {doc.effective_date ? (
              <>
                <dt>Effective</dt>
                <dd>{fmtDate(doc.effective_date, "short")}</dd>
              </>
            ) : null}
            {doc.last_reviewed ? (
              <>
                <dt>Reviewed</dt>
                <dd>{fmtDate(doc.last_reviewed, "short")}</dd>
              </>
            ) : null}
            {doc.next_review ? (
              <>
                <dt>Next review</dt>
                <dd>{fmtDate(doc.next_review, "short")}</dd>
              </>
            ) : null}
            {doc.shelf ? (
              <>
                <dt>Shelf</dt>
                <dd>{doc.shelf}</dd>
              </>
            ) : null}
            {languages.length > 0 ? (
              <>
                <dt>Languages</dt>
                <dd>{languages.join(", ")}</dd>
              </>
            ) : null}
          </dl>
          <div className="kf-docmeta__acts">
            <PrintDocButton />
            <Link href="/library" className="kf-btn kf-btn--line">
              <span>Back</span>
            </Link>
          </div>
        </section>
      </aside>

      <article className="kf-docarticle" aria-label={doc.title}>
        <div className="kf-docarticle__id-row">
          <span className="kf-cls kf-cls--id">{doc.id}</span>
          {classLabel ? <span className="kf-cls">{classLabel}</span> : null}
          {doc.status ? (
            <span className="kf-cls kf-cls--live">
              {doc.status}{versionLabel ? ` - ${versionLabel}` : ""}
            </span>
          ) : null}
          {result.languages.hasEn ? <span className="kf-cls">EN</span> : null}
          {result.languages.hasEs ? <span className="kf-cls kf-cls--es">ES</span> : null}
        </div>
        <h1 className="kf-docarticle__title">{doc.title}</h1>
        {doc.card_line ? <p className="kf-docarticle__lede">{doc.card_line}</p> : null}
        <div className="kf-docarticle__facts">
          {doc.owner ? <span><strong>Owner</strong> {doc.owner}</span> : null}
          {doc.effective_date ? <span><strong>Approved</strong> {fmtDate(doc.effective_date, "short")}</span> : null}
          {doc.next_review ? <span><strong>Next review</strong> {fmtDate(doc.next_review, "short")}</span> : null}
          {doc.shelf ? <span><strong>Shelf</strong> {doc.shelf}</span> : null}
        </div>
        {result.emptyContent ? (
          <section className="kf-docempty" aria-label="No content">
            <h3 className="kf-docempty__title">This document has no readable content yet</h3>
            <p className="kf-docempty__body">
              The record exists; the readable version has not been written. If this is a
              non-English posting, the Spanish train will surface it.
            </p>
            <Link href="/library" className="kf-btn kf-btn--primary">
              Back to Library
            </Link>
          </section>
        ) : (
          <div
            className="kf-docbody"
            // Server-rendered content_html with heading ids injected
            // above. No user-authored HTML enters here.
            dangerouslySetInnerHTML={{ __html: augmented }}
          />
        )}
      </article>
    </div>
  );
}
