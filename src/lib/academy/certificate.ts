// src/lib/academy/certificate.ts
//
// Academy certificate PDF generator. One page, US Letter portrait,
// typography-only (no seal image, no QR, no signature graphic). Built
// with pdf-lib.
//
// The point of the document is the VERBATIM attestation text. The
// person read a specific sentence at sign time; that exact sentence is
// stored on academy_attestations.attestation_text and reproduced on
// this certificate.
//
// Attempts are reported honestly. If it took three tries, the cert
// says three. No rounding, no hiding.
//
// Date formatting uses `Intl.DateTimeFormat("en-US", ...)` so the
// locale is pinned at the call site. Handler returns elsewhere stay
// ISO; the PDF is the one presentation surface that must render a
// human date.
//
// Dependency: pdf-lib.

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

// Brand palette.
const NAVY = rgb(15 / 255, 48 / 255, 87 / 255); // #0f3057
const MUSTARD = rgb(217 / 255, 119 / 255, 6 / 255); // #d97706
const GREY = rgb(100 / 255, 116 / 255, 139 / 255); // #64748b
const DIVIDER = rgb(226 / 255, 232 / 255, 240 / 255); // #e2e8f0
const WHITE = rgb(1, 1, 1);
const INK = rgb(15 / 255, 23 / 255, 42 / 255);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 56;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

export interface CertificateAttestation {
  typed_name?: string | null;
  doc_id?: string | null;
  obligation_key?: string | null;
  doc_version?: string | number | null;
  signed_at?: string | null;
  attempts_count?: number | null;
  time_spent_seconds?: number | null;
  certificate_serial?: string | null;
  attestation_text?: string | null;
}

export interface CertificateDoc {
  id?: string | null;
  title?: string | null;
  doc_class?: string | null;
  version?: string | number | null;
}

export interface CertificateObligation {
  source_section?: string | null;
}

export interface CertificateInput {
  attestation: CertificateAttestation;
  doc?: CertificateDoc | null;
  obligation?: CertificateObligation | null;
}

/**
 * Generate the certificate PDF for one attestation.
 */
export async function createCertificatePdf({
  attestation,
  doc,
  obligation,
}: CertificateInput): Promise<Uint8Array> {
  if (!attestation) {
    throw new Error("createCertificatePdf: attestation is required");
  }

  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // ── Header band (navy) ─────────────────────────────────────────
  const HEADER_H = 92;
  const headerY = PAGE_H - HEADER_H;
  page.drawRectangle({
    x: 0,
    y: headerY,
    width: PAGE_W,
    height: HEADER_H,
    color: NAVY,
  });
  const brandText = "KITCHFIX PERFORMANCE FOOD SERVICE";
  const brandSize = 12;
  const brandW = fontBold.widthOfTextAtSize(brandText, brandSize);
  page.drawText(brandText, {
    x: (PAGE_W - brandW) / 2,
    y: headerY + HEADER_H - 34,
    size: brandSize,
    font: fontBold,
    color: WHITE,
  });
  const titleText = "CERTIFICATE OF COMPLETION";
  const titleSize = 22;
  const titleW = fontBold.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: (PAGE_W - titleW) / 2,
    y: headerY + HEADER_H - 68,
    size: titleSize,
    font: fontBold,
    color: WHITE,
  });
  // Mustard rule under the header band.
  page.drawRectangle({
    x: 0,
    y: headerY - 3,
    width: PAGE_W,
    height: 3,
    color: MUSTARD,
  });

  // ── Person name ────────────────────────────────────────────────
  let cursor = headerY - 60;
  const awardedLine = "This certifies that";
  const awardedSize = 10;
  const awardedW = fontRegular.widthOfTextAtSize(awardedLine, awardedSize);
  page.drawText(awardedLine, {
    x: (PAGE_W - awardedW) / 2,
    y: cursor,
    size: awardedSize,
    font: fontRegular,
    color: GREY,
  });
  cursor -= 32;

  const typedName = String(attestation.typed_name || "").trim() || "-";
  const nameSize = 26;
  const nameW = fontBold.widthOfTextAtSize(typedName, nameSize);
  page.drawText(typedName, {
    x: (PAGE_W - nameW) / 2,
    y: cursor,
    size: nameSize,
    font: fontBold,
    color: NAVY,
  });
  cursor -= 24;

  // ── Module title + doc it comes from ───────────────────────────
  const completedLine = "has completed";
  const completedW = fontRegular.widthOfTextAtSize(completedLine, awardedSize);
  page.drawText(completedLine, {
    x: (PAGE_W - completedW) / 2,
    y: cursor,
    size: awardedSize,
    font: fontRegular,
    color: GREY,
  });
  cursor -= 26;

  // The large "has completed" line is the MODULE title, derived from
  // the obligation's source_section by the same partShortTitle logic
  // the room uses. If no module title can be derived (missing
  // obligation row or empty source_section), the document title
  // stands in. Never obligation_key - spec 18.3 prohibits it in
  // operator-facing copy, and a printed certificate is the strongest
  // case of operator-facing.
  const derivedModule = partShortTitle(obligation?.source_section || "");
  const docTitle = String(doc?.title || "").trim();
  const moduleTitle = derivedModule || docTitle || attestation.doc_id || "-";
  const modSize = 15;
  const modW = fontBold.widthOfTextAtSize(moduleTitle, modSize);
  page.drawText(moduleTitle, {
    x: (PAGE_W - modW) / 2,
    y: cursor,
    size: modSize,
    font: fontBold,
    color: INK,
  });
  cursor -= 16;

  // Document context beneath: "Culture OS Handbook - PB-014 - version 1.0".
  // Only include the doc title if we actually used a derived module
  // title above (otherwise the two lines would repeat the same string).
  // Never obligation_key.
  const docSubParts: string[] = [];
  if (derivedModule && docTitle) docSubParts.push(docTitle);
  if (attestation.doc_id) docSubParts.push(String(attestation.doc_id));
  const subVersion = attestation.doc_version || doc?.version;
  if (subVersion != null && subVersion !== "") docSubParts.push(`version ${subVersion}`);
  const docSub = docSubParts.join("  -  ");
  if (docSub) {
    const docSubW = fontRegular.widthOfTextAtSize(docSub, 9);
    page.drawText(docSub, {
      x: (PAGE_W - docSubW) / 2,
      y: cursor,
      size: 9,
      font: fontRegular,
      color: GREY,
    });
    cursor -= 20;
  } else {
    cursor -= 8;
  }

  // ── Divider ────────────────────────────────────────────────────
  page.drawRectangle({
    x: MARGIN_X,
    y: cursor,
    width: CONTENT_W,
    height: 1,
    color: DIVIDER,
  });
  cursor -= 22;

  // ── Attestation text (VERBATIM) ────────────────────────────────
  const attestLabel = "ATTESTATION";
  page.drawText(attestLabel, {
    x: MARGIN_X,
    y: cursor,
    size: 8,
    font: fontBold,
    color: MUSTARD,
  });
  cursor -= 16;

  const attestText = String(attestation.attestation_text || "").trim();
  const attestSize = 11;
  const attestLineHeight = 15;
  const wrapped = wrapText(attestText, fontRegular, attestSize, CONTENT_W);
  for (const line of wrapped) {
    page.drawText(line, {
      x: MARGIN_X,
      y: cursor,
      size: attestSize,
      font: fontRegular,
      color: INK,
    });
    cursor -= attestLineHeight;
  }
  cursor -= 8;

  // ── Divider ────────────────────────────────────────────────────
  page.drawRectangle({
    x: MARGIN_X,
    y: cursor,
    width: CONTENT_W,
    height: 1,
    color: DIVIDER,
  });
  cursor -= 22;

  // ── Detail block ───────────────────────────────────────────────
  const detailsLabel = "RECORD";
  page.drawText(detailsLabel, {
    x: MARGIN_X,
    y: cursor,
    size: 8,
    font: fontBold,
    color: MUSTARD,
  });
  cursor -= 16;

  const attempts = Number.isFinite(Number(attestation.attempts_count))
    ? Number(attestation.attempts_count)
    : 0;
  const timeSec = Number.isFinite(Number(attestation.time_spent_seconds))
    ? Number(attestation.time_spent_seconds)
    : 0;
  const minutes = timeSec > 0 ? Math.max(1, Math.round(timeSec / 60)) : 0;
  const signedAt = attestation.signed_at ? new Date(attestation.signed_at) : null;

  // Attempts is reported honestly: if the row says 3, the certificate
  // says "3 attempts". No rounding, no hiding, no "on first try" if it
  // wasn't.
  const checkLine =
    attempts === 0
      ? "no checks required for this module"
      : `passed - ${attempts} attempt${attempts === 1 ? "" : "s"}`;

  const details: Array<[string, string]> = [
    [
      "Document",
      `${attestation.doc_id || "-"}${
        attestation.doc_version ? `  -  version ${attestation.doc_version}` : ""
      }`,
    ],
    ["Signed", signedAt ? formatSigned(signedAt) : "-"],
    ["Comprehension checks", checkLine],
    [
      "Time on module",
      minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "not recorded",
    ],
  ];

  const labelX = MARGIN_X;
  const valueX = MARGIN_X + 170;
  for (const [label, value] of details) {
    page.drawText(label, {
      x: labelX,
      y: cursor,
      size: 9,
      font: fontBold,
      color: GREY,
    });
    const valueW = CONTENT_W - (valueX - MARGIN_X);
    const valueLines = wrapText(value, fontRegular, 10, valueW);
    let vy = cursor;
    for (const vl of valueLines) {
      page.drawText(vl, {
        x: valueX,
        y: vy,
        size: 10,
        font: fontRegular,
        color: INK,
      });
      vy -= 13;
    }
    cursor = Math.min(cursor - 18, vy - 4);
  }

  // ── Closing line ───────────────────────────────────────────────
  cursor -= 8;
  const closing =
    "This record is permanent and version-bound. If this document is materially revised, this certificate expires and a new signature is required.";
  const closingLines = wrapText(closing, fontRegular, 9, CONTENT_W);
  for (const line of closingLines) {
    page.drawText(line, {
      x: MARGIN_X,
      y: cursor,
      size: 9,
      font: fontRegular,
      color: GREY,
    });
    cursor -= 12;
  }

  // ── Footer: serial, prominent ──────────────────────────────────
  const FOOTER_H = 72;
  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_W,
    height: FOOTER_H,
    color: NAVY,
  });
  const serial = String(attestation.certificate_serial || "").trim() || "-";
  const serialLabel = "CERTIFICATE SERIAL";
  const serialLabelSize = 8;
  const serialLabelW = fontBold.widthOfTextAtSize(serialLabel, serialLabelSize);
  page.drawText(serialLabel, {
    x: (PAGE_W - serialLabelW) / 2,
    y: FOOTER_H - 24,
    size: serialLabelSize,
    font: fontBold,
    color: MUSTARD,
  });
  const serialSize = 20;
  const serialW = fontBold.widthOfTextAtSize(serial, serialSize);
  page.drawText(serial, {
    x: (PAGE_W - serialW) / 2,
    y: FOOTER_H - 52,
    size: serialSize,
    font: fontBold,
    color: WHITE,
  });

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

// ── Helpers ──

// First section from source_section, truncated to ~40 chars at a word
// boundary. Same derivation the room uses.
export function partShortTitle(sourceSection: string | null | undefined): string {
  const src = String(sourceSection || "").trim();
  if (!src) return "";
  const first = src.split(/;/, 1)[0].trim();
  if (!first) return "";
  const MAX = 40;
  if (first.length <= MAX) return first;
  const cut = first.slice(0, MAX);
  const lastSp = cut.lastIndexOf(" ");
  return (lastSp > 20 ? cut.slice(0, lastSp) : cut).replace(/[\s,.·-]+$/, "") + "…";
}

function formatSigned(d: Date): string {
  try {
    const date = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
    return `${date} at ${time}`;
  } catch {
    return String(d);
  }
}

// Word-wrap that respects the font's actual glyph widths.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  if (!text) return [""];
  const paragraphs = String(text).split(/\n/);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const attempt = line ? `${line} ${w}` : w;
      const attemptW = font.widthOfTextAtSize(attempt, size);
      if (attemptW <= maxWidth) {
        line = attempt;
        continue;
      }
      if (line) {
        out.push(line);
        line = "";
      }
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          const cw = font.widthOfTextAtSize(chunk + ch, size);
          if (cw > maxWidth && chunk) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}
