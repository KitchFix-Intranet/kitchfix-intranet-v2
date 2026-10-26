// Attestation-sentence builder.
//
// attestation_text is stored verbatim on academy_attestations and
// printed on the certificate. What this returns is what the person
// legally attested to. Two definitions of a legal sentence will
// drift, so every caller routes through here.
//
// Approved wording:
//   With a module split:
//     I, {name}, have read and understood {module title}, from the
//     {document title}, version {version}, and I will hold this
//     standard at my sites.
//   Without a module split (single-part document, moduleTitle empty):
//     I, {name}, have read and understood {document title}, version
//     {version}, and I will hold this standard at my sites.
//
// Module title derivation lives in moduleTitleForAttestation below.
// Single-section obligations use the section heading; multi-section
// obligations derive the module NAME from the obligation's description
// (the lead clause before " - ") because naming only the first section
// understates what the person attested to.
//
// partShortTitle returns the display string INCLUDING the part prefix
// ("Part N · Something"). "Part N ·" is a list prefix and the middle
// dot (U+00B7) is a UI separator; neither belongs inside a sentence a
// person is legally attesting to. Strip the prefix here so all callers
// get a clean module title. Do NOT strip in the room or on the
// certificate - the prefix is correct there.
//
// Server-side only. The sign handler ignores any client-supplied
// `attestationText` and rebuilds the sentence from the requirement's
// document, obligation and the viewer's display name.

const PART_PREFIX = /^Part\s+\d+\s*·\s*/;

export interface AttestationSentenceInput {
  displayName: string | null | undefined;
  moduleTitle: string | null | undefined;
  documentTitle: string | null | undefined;
  version: string | number | null | undefined;
}

export function buildAttestationSentence({
  displayName,
  moduleTitle,
  documentTitle,
  version,
}: AttestationSentenceInput): string {
  const name = String(displayName || "").trim();
  const doc = String(documentTitle || "").trim() || "this document";
  const modRaw = String(moduleTitle || "").trim();
  const mod = modRaw.replace(PART_PREFIX, "").trim();
  const ver = String(version || "").trim() || "?";
  if (mod && mod !== doc) {
    return `I, ${name}, have read and understood ${mod}, from the ${doc}, version ${ver}, and I will hold this standard at my sites.`;
  }
  return `I, ${name}, have read and understood ${doc}, version ${ver}, and I will hold this standard at my sites.`;
}

// Length cap shared by partShortTitle and the multi-section fallback.
// A title longer than this is better dropped than crammed into the
// rendered chrome; buildAttestationSentence then produces the document-
// only form.
const MODULE_TITLE_MAX = 40;

// Duplicate of certificate.ts:partShortTitle. Duplicated rather than
// imported because certificate.ts pulls in pdf-lib and this module is
// also imported by client code (the Reader's live sentence preview).
// Keep the two implementations in lockstep; both exist to answer the
// same question: "what single section does this obligation cover?"
function partShortTitleInline(sourceSection: string | null | undefined): string {
  const src = String(sourceSection || "").trim();
  if (!src) return "";
  const first = src.split(/;/, 1)[0].trim();
  if (!first) return "";
  if (first.length <= MODULE_TITLE_MAX) return first;
  const cut = first.slice(0, MODULE_TITLE_MAX);
  const lastSp = cut.lastIndexOf(" ");
  return (lastSp > 20 ? cut.slice(0, lastSp) : cut).replace(/[\s,.·-]+$/, "") + "…";
}

// Title-case a plain string: capitalise the first letter of each
// whitespace-split word. Leaves "and", "of", etc. in title case too
// because an authored module name reads cleaner uppercased edge to
// edge than naturalised; the authored-title train replaces this
// derivation entirely.
function titleCaseLead(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * The module title the attestation sentence names.
 *
 * Single-section obligation (`source_section` has no ";"): the single
 * section IS the module; partShortTitle preserves historical behaviour.
 * `culture-os-origin` ("Origin: Where It All Comes From") lands here.
 *
 * Multi-section obligation (`source_section` has ";"): the first
 * section does NOT name the module. The authored module name sits in
 * the obligation's description lead - the text before the first " - ".
 * `culture-os-standard`'s description starts "What we hold -", so the
 * module title is "What We Hold" (title-cased). This produces the
 * sentence "...read and understood What We Hold, from the Culture OS
 * Handbook, version 1.0...".
 *
 * Fallback: empty string. buildAttestationSentence then emits the
 * document-only form "...read and understood {document}, version {v}..."
 * - an empty title is the safe default; never emit a wrong section
 * name. `culture-os-standard-annual`'s description has no " - " in
 * its lead clause, so it falls here today and names the document.
 */
export function moduleTitleForAttestation({
  sourceSection,
  description,
}: {
  sourceSection: string | null | undefined;
  description: string | null | undefined;
}): string {
  const src = String(sourceSection || "").trim();

  // Single section: historical behaviour.
  if (!src.includes(";")) {
    return partShortTitleInline(src);
  }

  // Multi-section: derive from description's lead clause.
  const desc = String(description || "").trim();
  if (!desc) return "";
  const dashIdx = desc.indexOf(" - ");
  if (dashIdx <= 0) return "";

  const lead = desc.slice(0, dashIdx).trim();
  if (!lead) return "";

  const titled = titleCaseLead(lead);
  if (titled.length > MODULE_TITLE_MAX) return "";

  return titled;
}

/**
 * Read the module title back OUT of a stored attestation sentence.
 *
 * The certificate renders two text blocks: the ATTESTATION body (the
 * stored sentence, verbatim) and the "has completed" header above
 * it (a short label). Historically the header was re-derived from
 * `obligation.source_section` via partShortTitle - which meant that
 * for a multi-section obligation signed under the old title derivation
 * (e.g. KFA-2026-000002), the header would AGREE with the stored body
 * (both say the first section). As we change what new signatures
 * store, re-deriving at render time would make OLD certificates'
 * header disagree with their stored body.
 *
 * Reading the title FROM the stored text keeps every certificate
 * internally consistent across time: old rows still show their old
 * (now-superseded) title in both header and body; new rows show the
 * new title in both. The caller falls back to the document title if
 * the regex does not match (which happens when the stored sentence
 * used the document-only fallback form).
 */
export function extractModuleTitleFromAttestationText(
  attestationText: string | null | undefined,
): string {
  const t = String(attestationText || "");
  const m = t.match(/have read and understood\s+(.+?),\s+from the\s+/);
  if (m && m[1]) return m[1].trim();
  return "";
}
