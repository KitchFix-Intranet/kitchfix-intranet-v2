// /library/[docId] - the read-only document viewer. Server component.
// loadDocument(email, docId) returns the document metadata, the
// pre-rendered English HTML, the viewer's Academy status (does it
// train them, have they signed), and language flags.
//
// READ-ONLY. No progress POST, no attempt, no attestation. The
// Reader from train C is deliberately NOT used here - it is
// requirement-keyed and wired to checks/sign; a Library document is
// not a requirement. We reuse the Academy pane CSS (.kf-reader /
// .kf-reader__head / .kf-reader__body) for layout and chrome only.
//
// Not Live or missing document -> notFound(). Missing en content ->
// render the "no readable content yet" empty state inside the pane.

import Link from "next/link";
import { ArrowRight, Check, Download } from "lucide-react";
import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { loadDocument } from "@/lib/academy/document";
import { humanizeDocClass } from "@/lib/academy/docClass";
import { fmtDate } from "@/lib/fmt";
import "@/components/academy/academy.css";
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

// Parse h1-h3 from the rendered HTML into a flat outline list and
// inject matching ids on the headings so in-page anchor links work.
// Returns the augmented HTML and the outline.
function buildOutline(html: string | null): {
  augmented: string;
  outline: Array<{ level: number; text: string; anchor: string }>;
} {
  if (!html) return { augmented: "", outline: [] };
  const outline: Array<{ level: number; text: string; anchor: string }> = [];
  const seen = new Map<string, number>();
  // First, derive the outline and anchors.
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
  // Then inject matching ids. We walk the headings in order again and
  // replace the opening tag with one that carries the id. Replaces by
  // index to stay stable against repeated anchors.
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
  const { email } = await requireOwnerPage();
  const { docId } = await params;

  const result = await loadDocument(email, docId);

  if (!result.ok) {
    if (result.status === 404) notFound();
    // Any other non-ok (500 etc.) also 404s to avoid a bare error
    // page in a learner-facing surface.
    notFound();
  }

  const doc = result.doc;
  const { augmented, outline } = buildOutline(result.content_html);

  // Human-readable version string. Document version is a number or
  // string in the data; display as "v1.0" with no trailing padding.
  const versionLabel = doc.version != null ? `v${doc.version}` : null;
  const classLabel = humanizeDocClass(doc.doc_class);

  const languages: string[] = [];
  if (result.languages.hasEn) languages.push("English");
  if (result.languages.hasEs) languages.push("Spanish");

  const signedAt = result.signedAttestation?.signed_at ?? null;
  const certificateHref = result.signedAttestation
    ? `/api/academy/certificate/${result.signedAttestation.attestation_id}`
    : null;

  return (
    <div className="kf-docview">
      <section className="kf-reader kf-docview__pane" aria-label="Document">
        <header className="kf-reader__head">
          <div className="kf-reader__head-text">
            <h2 className="kf-reader__title">{doc.title}</h2>
            <p className="kf-reader__sub">
              {[classLabel, doc.id, versionLabel].filter(Boolean).join(" - ")}
            </p>
          </div>
          <div className="kf-reader__head-right">
            {result.trainsYou && result.openRequirementId ? (
              <Link
                href={`/academy/read/${result.openRequirementId}`}
                className="kf-btn kf-btn--line"
              >
                <span>Open in Academy</span>
                <ArrowRight size={16} strokeWidth={1.5} />
              </Link>
            ) : null}
          </div>
        </header>

        <div className="kf-reader__body">
          {result.emptyContent ? (
            <section className="kf-docview__empty" aria-label="No content">
              <h3 className="kf-docview__empty-title">This document has no readable content yet</h3>
              <p className="kf-docview__empty-body">
                The record exists; the readable version has not been written. If this is a
                non-English posting, the Spanish train will surface it.
              </p>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Link href="/library" className="kf-btn kf-btn--primary">
                  Back to Library
                </Link>
              </div>
            </section>
          ) : (
            <>
              {outline.length > 0 ? (
                <nav className="kf-docview__contents" aria-label="Contents">
                  <span className="kf-docview__contents-head">Contents</span>
                  <ul className="kf-docview__contents-list">
                    {outline.map((o) => (
                      <li key={o.anchor}>
                        <a
                          href={`#${o.anchor}`}
                          className={`kf-docview__contents-item kf-docview__contents-item--l${o.level}`}
                        >
                          {o.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              ) : null}
              <article
                className="kf-reader__prose"
                dangerouslySetInnerHTML={{ __html: augmented }}
              />
            </>
          )}
        </div>

        <footer className="kf-docview__foot-note">
          Reading, not signing. Nothing here is recorded.
        </footer>
      </section>

      <aside className="kf-docfacts" aria-label="Document facts">
        <div className="kf-docfacts__head">
          <span className="kf-docfacts__eyebrow">About this document</span>
          <h3 className="kf-docfacts__title">{doc.title}</h3>
        </div>
        <dl className="kf-kv" aria-label="Facts">
          <div>
            <dt>Number</dt>
            <dd>{doc.id}</dd>
          </div>
          <div>
            <dt>Class</dt>
            <dd>{classLabel || "-"}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{versionLabel ?? "-"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="kf-pill kf-pill--live">{doc.status}</span>
            </dd>
          </div>
          {doc.owner ? (
            <div>
              <dt>Owner</dt>
              <dd>{doc.owner}</dd>
            </div>
          ) : null}
          {doc.effective_date ? (
            <div>
              <dt>Effective</dt>
              <dd>{fmtDate(doc.effective_date, "short")}</dd>
            </div>
          ) : null}
          {doc.last_reviewed ? (
            <div>
              <dt>Reviewed</dt>
              <dd>{fmtDate(doc.last_reviewed, "short")}</dd>
            </div>
          ) : null}
          {languages.length > 0 ? (
            <div>
              <dt>Languages</dt>
              <dd>{languages.join(", ")}</dd>
            </div>
          ) : null}
        </dl>

        {result.signedAttestation ? (
          <div className="kf-docfacts__status">
            <span className="kf-docfacts__status-signed">
              <Check size={14} strokeWidth={2} aria-hidden /> Signed {signedAt ? fmtDate(signedAt, "short") : ""}
            </span>
            {result.signedAttestation.certificate_serial ? (
              <span className="kf-sign__hint">
                Certificate {result.signedAttestation.certificate_serial}
              </span>
            ) : null}
            {certificateHref ? (
              <div className="kf-docfacts__cta-row">
                <Link href={certificateHref} className="kf-btn kf-btn--line" prefetch={false}>
                  <Download size={14} strokeWidth={1.5} />
                  <span>Certificate PDF</span>
                </Link>
              </div>
            ) : null}
          </div>
        ) : result.trainsYou && result.openRequirementId ? (
          <div className="kf-docfacts__status">
            <span className="kf-docfacts__status-todo">On your to-do list</span>
            <span className="kf-sign__hint">
              Signing in Academy records progress and the signature. Reading here records
              nothing.
            </span>
            <div className="kf-docfacts__cta-row">
              <Link
                href={`/academy/read/${result.openRequirementId}`}
                className="kf-btn kf-btn--primary"
              >
                <span>Open in Academy</span>
                <ArrowRight size={14} strokeWidth={1.5} />
              </Link>
            </div>
          </div>
        ) : result.trainsYou ? (
          <div className="kf-docfacts__status">
            <span className="kf-docfacts__status-todo">On your to-do list</span>
            <span className="kf-sign__hint">
              An open requirement for this document is not available on your list right now.
            </span>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
