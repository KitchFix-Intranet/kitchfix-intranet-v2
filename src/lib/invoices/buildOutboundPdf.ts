// src/lib/invoices/buildOutboundPdf.ts - server-only.
//
// Fixes from the pre-push walk:
//
// 1. A file that fails to download fails the build. The caller
//    (deliverSend) catches the tagged error and holds with code
//    `original_read_failed`; an invoice is never emailed unless
//    every live original is in the email.
//
// 2. No hidden attachments. `pdf-lib`'s `.attach` embeds a file
//    inside the PDF where most viewers never show it. Instead,
//    any original that cannot be rendered on a page in the main
//    bundle is returned as an EXTRA email attachment:
//      - a PDF pdf-lib cannot open: extras.push the bytes
//        unchanged + the coding page rides in the main bundle
//        (per prompt §6);
//      - a WebP: pdf-lib has no embedder, extras.push the bytes;
//      - a JPEG/PNG that fails to embed: extras.push;
//      - any other mime type: extras.push.
//    The caller passes extras to sendSystemMail alongside the
//    built PDF. Size caps apply to the total.
//
// 3. Coding lines never clip. paginateCodingLines decides the
//    split; a new coding page starts with the column heads
//    repeated. All 60 of 60 lines land on the output.
//
// 5. Rotation adds to the page's own rotation:
//    (page.getRotation().angle + rotation) % 360.
//
// 6. Every drawText call runs through encodeForFont first so a
//    vendor name with an emoji or CJK cannot throw.

if (typeof window !== "undefined") {
  throw new Error("src/lib/invoices/buildOutboundPdf.ts is server-only");
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import type { CodingPageData } from "./codingPageData";
import { paginateCodingLines } from "./codingPagePaginate";
import { encodeForFont } from "./encodeForFont";

const BUCKET = "invoice-files";
const PAGE_W = 612;   // US letter, points
const PAGE_H = 792;
const MARGIN = 54;    // 0.75"

// Coding page layout: the first page holds the title + five
// labelled rows + the "Coding" title + column heads above the
// line table; later pages hold just the column heads.
const FIRST_PAGE_LINE_CAP = 22;
const FULL_PAGE_LINE_CAP = 42;
const LINE_ROW_HEIGHT = 16;

export interface OutboundFileRef {
  storage_path: string;
  mime_type: string;        // application/pdf | image/jpeg | image/png | image/webp | other
  rotation: 0 | 90 | 180 | 270;
  file_name: string | null; // used for the extra-attachment filename
}

export interface ExtraAttachment {
  filename: string;
  mimeType: string;
  base64: string;
}

export interface BuildResult {
  bytes: Uint8Array;
  extras: ExtraAttachment[];
}

// Thrown when ANY original file cannot be read from the bucket.
// The deliver function maps this to the code `original_read_failed`
// and holds the send; the retry route will try again.
export class OriginalReadFailed extends Error {
  readonly tag = "original_read_failed" as const;
  constructor(public readonly storagePath: string) {
    super(`original_read_failed`);
  }
}

function cleanExtraFilename(raw: string | null | undefined, fallbackExt: string): string {
  const base = (raw ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!base) return `original.${fallbackExt}`;
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  return safe.includes(".") ? safe : `${safe}.${fallbackExt}`;
}

function extFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// Scale a (w, h) image into the content box, centred.
function scaleBox(w: number, h: number): { x: number; y: number; width: number; height: number } {
  const maxW = PAGE_W - MARGIN * 2;
  const maxH = PAGE_H - MARGIN * 2;
  const scale = Math.min(maxW / w, maxH / h, 1);
  const outW = w * scale;
  const outH = h * scale;
  return { x: (PAGE_W - outW) / 2, y: (PAGE_H - outH) / 2, width: outW, height: outH };
}

export async function buildOutboundPdf(
  sb: SupabaseClient,
  files: ReadonlyArray<OutboundFileRef>,
  coding: CodingPageData,
): Promise<BuildResult> {
  const out = await PDFDocument.create();
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const extras: ExtraAttachment[] = [];

  // Every drawText goes through this one call so a bad codepoint
  // never crashes the build.
  const draw = (page: ReturnType<typeof out.addPage>, text: string, opts: { x: number; y: number; size: number; font: typeof helv; color?: ReturnType<typeof rgb> }) => {
    page.drawText(encodeForFont(text), opts);
  };

  for (const f of files) {
    const dl = await sb.storage.from(BUCKET).download(f.storage_path);
    // Fix 1: download failure is a build failure. Never skip an
    // original silently.
    if (dl.error || !dl.data) throw new OriginalReadFailed(f.storage_path);
    const bytes = new Uint8Array(await dl.data.arrayBuffer());

    if (f.mime_type === "application/pdf") {
      try {
        const src = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
        const indices = src.getPageIndices();
        const copied = await out.copyPages(src, indices);
        for (const p of copied) {
          // Fix 5: add rotation to whatever the page already carries.
          const existing = p.getRotation().angle;
          const combined = ((existing + f.rotation) % 360 + 360) % 360;
          p.setRotation(degrees(combined));
          out.addPage(p);
        }
      } catch {
        // A locked or damaged PDF. Fix 2: no hidden attach; ride
        // the original bytes as an email attachment and let the
        // coding page be added as a one-page PDF (the main
        // bundle below, which is just the coding page if nothing
        // else rendered).
        extras.push({
          filename: cleanExtraFilename(f.file_name, "pdf"),
          mimeType: "application/pdf",
          base64: Buffer.from(bytes).toString("base64"),
        });
      }
    } else if (f.mime_type === "image/jpeg" || f.mime_type === "image/png") {
      try {
        const img = f.mime_type === "image/jpeg"
          ? await out.embedJpg(bytes)
          : await out.embedPng(bytes);
        const p = out.addPage([PAGE_W, PAGE_H]);
        const box = scaleBox(img.width, img.height);
        p.drawImage(img, box);
        if (f.rotation !== 0) {
          const existing = p.getRotation().angle;
          const combined = ((existing + f.rotation) % 360 + 360) % 360;
          p.setRotation(degrees(combined));
        }
      } catch {
        // pdf-lib refused to embed. Send the bytes as an email
        // attachment. Fix 2: no silent swallow - the error sends
        // the bytes out.
        extras.push({
          filename: cleanExtraFilename(f.file_name, extFromMime(f.mime_type)),
          mimeType: f.mime_type,
          base64: Buffer.from(bytes).toString("base64"),
        });
      }
    } else {
      // image/webp and anything else: pdf-lib has no embedder,
      // so the original goes as its own email attachment.
      extras.push({
        filename: cleanExtraFilename(f.file_name, extFromMime(f.mime_type)),
        mimeType: f.mime_type,
        base64: Buffer.from(bytes).toString("base64"),
      });
    }
  }

  // Coding page(s). Fix 3: paginate so no line gets cut off.
  const { pages: codingLinePages } = paginateCodingLines(
    coding.lines,
    FIRST_PAGE_LINE_CAP,
    FULL_PAGE_LINE_CAP,
  );

  codingLinePages.forEach((linesOnPage, pageIdx) => {
    const page = out.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    if (pageIdx === 0) {
      if (coding.isTest) {
        draw(page, "[TEST]", { x: MARGIN, y, size: 14, font: bold, color: rgb(0, 0, 0) });
        y -= 22;
      }
      draw(page, coding.title, { x: MARGIN, y, size: 20, font: bold, color: rgb(0, 0, 0) });
      y -= 28;

      const rows: Array<[string, string]> = [
        ["Site", coding.site],
        ["Vendor", coding.vendor],
        [coding.numberLabel, coding.number],
        [coding.dateLabel, coding.dateDisplay],
        [coding.totalLabel, coding.totalDisplay],
      ];
      for (const [label, value] of rows) {
        draw(page, label, { x: MARGIN, y, size: 11, font: helv, color: rgb(0.35, 0.35, 0.35) });
        draw(page, value, { x: MARGIN + 110, y, size: 11, font: bold, color: rgb(0, 0, 0) });
        y -= 18;
      }
      y -= 10;
      draw(page, "Coding", { x: MARGIN, y, size: 13, font: bold, color: rgb(0, 0, 0) });
      y -= 20;
    } else {
      // Later pages: just the heading and the column heads.
      draw(page, `Coding (continued)`, { x: MARGIN, y, size: 13, font: bold, color: rgb(0, 0, 0) });
      y -= 20;
    }

    // Column heads.
    draw(page, "Code", { x: MARGIN, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
    draw(page, "Name", { x: MARGIN + 70, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
    draw(page, "Amount", { x: PAGE_W - MARGIN - 70, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
    y -= 14;

    for (const l of linesOnPage) {
      draw(page, l.code, { x: MARGIN, y, size: 11, font: helv, color: rgb(0, 0, 0) });
      draw(page, l.name, { x: MARGIN + 70, y, size: 11, font: helv, color: rgb(0, 0, 0) });
      draw(page, l.amountDisplay, { x: PAGE_W - MARGIN - 70, y, size: 11, font: helv, color: rgb(0, 0, 0) });
      y -= LINE_ROW_HEIGHT;
    }

    // Footer only on the last page.
    if (pageIdx === codingLinePages.length - 1) {
      const footY = MARGIN + 20;
      const foot: string[] = [];
      if (coding.byline) foot.push(`Sent by ${coding.byline}`);
      foot.push(`Sent ${coding.whenDisplay}`);
      draw(page, foot.join(" - "), { x: MARGIN, y: footY, size: 9, font: helv, color: rgb(0.35, 0.35, 0.35) });
    }
  });

  const bytes = await out.save();
  return { bytes, extras };
}
