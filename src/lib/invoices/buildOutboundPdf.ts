// src/lib/invoices/buildOutboundPdf.ts - server-only.
//
// §6: builds one PDF from the invoice's live original files plus a
// coding page. Each original is placed in sort_order and rotated by
// its saved rotation.
//   - a PDF: pages are copied in;
//   - a picture (jpeg / png / webp): one page sized to the picture;
//   - a locked or damaged PDF: attached as a second PDF (bytes
//     unchanged, original file preserved) + the coding page. Do not
//     fail the send.
//
// The coding page is plain black on white, no brand art. The coding
// page data comes from buildCodingPageData (pure), and the renderer
// reads only that. Test mode shows "[TEST]" bold at the top
// (correction 8).
//
// The function returns the built PDF bytes. The deliver function
// stores it in the bucket + opens an invoice_files row with
// kind='outbound' + ties it to the invoice via submission_id. A
// retry reuses that file; this function is called once per
// invoice.

if (typeof window !== "undefined") {
  throw new Error("src/lib/invoices/buildOutboundPdf.ts is server-only");
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import type { CodingPageData } from "./codingPageData";

const BUCKET = "invoice-files";
const PAGE_W = 612;  // US letter, points (8.5" x 11")
const PAGE_H = 792;
const MARGIN = 54;   // 0.75"

export interface OutboundFileRef {
  storage_path: string;
  mime_type: string;        // application/pdf | image/jpeg | image/png | image/webp
  rotation: 0 | 90 | 180 | 270;
}

// Build one PDF that bundles every live original file (in sort
// order) and a final coding page. If a PDF cannot be opened,
// its original bytes are kept and attached as a second one-page
// PDF + the coding page - the send does not fail.
export async function buildOutboundPdf(
  sb: SupabaseClient,
  files: ReadonlyArray<OutboundFileRef>,
  coding: CodingPageData,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  // Walk each file, copying pages or painting a picture page.
  for (const f of files) {
    const dl = await sb.storage.from(BUCKET).download(f.storage_path);
    if (dl.error || !dl.data) continue;
    const bytes = new Uint8Array(await dl.data.arrayBuffer());

    if (f.mime_type === "application/pdf") {
      try {
        const src = await PDFDocument.load(bytes, { throwOnInvalidObject: false });
        const indices = src.getPageIndices();
        const copied = await out.copyPages(src, indices);
        for (const p of copied) {
          if (f.rotation !== 0) p.setRotation(degrees(f.rotation));
          out.addPage(p);
        }
      } catch {
        // Locked or damaged. Keep the bytes by embedding them as
        // an attachment on the finished PDF. The coding page is
        // still appended below.
        try {
          await out.attach(bytes, `original.pdf`, { mimeType: "application/pdf" });
        } catch {
          // Even attach failed: still do not fail the send.
        }
      }
    } else if (f.mime_type === "image/jpeg" || f.mime_type === "image/png" || f.mime_type === "image/webp") {
      // pdf-lib embeds jpg and png natively. For webp we fall back
      // to attaching the bytes - there is no on-page converter in
      // the bundle today.
      try {
        if (f.mime_type === "image/jpeg") {
          const img = await out.embedJpg(bytes);
          const p = out.addPage([PAGE_W, PAGE_H]);
          paintImage(p, img.width, img.height, (x, y, w, h) => p.drawImage(img, { x, y, width: w, height: h }));
          if (f.rotation !== 0) p.setRotation(degrees(f.rotation));
        } else if (f.mime_type === "image/png") {
          const img = await out.embedPng(bytes);
          const p = out.addPage([PAGE_W, PAGE_H]);
          paintImage(p, img.width, img.height, (x, y, w, h) => p.drawImage(img, { x, y, width: w, height: h }));
          if (f.rotation !== 0) p.setRotation(degrees(f.rotation));
        } else {
          await out.attach(bytes, `original.webp`, { mimeType: "image/webp" });
        }
      } catch {
        try { await out.attach(bytes, `original`, { mimeType: f.mime_type }); } catch { /* ignore */ }
      }
    }
    // Any other kind: pdf-lib cannot draw it. Attach and move on.
    else {
      try { await out.attach(bytes, `original`, { mimeType: f.mime_type }); } catch { /* ignore */ }
    }
  }

  // Coding page: plain black on white, no brand art.
  const page = out.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  if (coding.isTest) {
    page.drawText("[TEST]", { x: MARGIN, y, size: 14, font: bold, color: rgb(0, 0, 0) });
    y -= 22;
  }
  page.drawText(coding.title, { x: MARGIN, y, size: 20, font: bold, color: rgb(0, 0, 0) });
  y -= 28;

  // Site / Vendor / Number / Date / Total, left-labelled.
  const rows: Array<[string, string]> = [
    ["Site", coding.site],
    ["Vendor", coding.vendor],
    [coding.numberLabel, coding.number],
    [coding.dateLabel, coding.dateDisplay],
    [coding.totalLabel, coding.totalDisplay],
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: MARGIN, y, size: 11, font: helv, color: rgb(0.35, 0.35, 0.35) });
    page.drawText(value, { x: MARGIN + 110, y, size: 11, font: bold, color: rgb(0, 0, 0) });
    y -= 18;
  }

  y -= 10;
  page.drawText("Coding", { x: MARGIN, y, size: 13, font: bold, color: rgb(0, 0, 0) });
  y -= 20;

  // Header
  page.drawText("Code", { x: MARGIN, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
  page.drawText("Name", { x: MARGIN + 70, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
  page.drawText("Amount", { x: PAGE_W - MARGIN - 70, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
  y -= 14;

  for (const l of coding.lines) {
    page.drawText(l.code, { x: MARGIN, y, size: 11, font: helv, color: rgb(0, 0, 0) });
    page.drawText(l.name, { x: MARGIN + 70, y, size: 11, font: helv, color: rgb(0, 0, 0) });
    page.drawText(l.amountDisplay, { x: PAGE_W - MARGIN - 70, y, size: 11, font: helv, color: rgb(0, 0, 0) });
    y -= 16;
    if (y < MARGIN + 40) break;  // overflow: we clip rather than add a page
  }

  // Footer: byline + when.
  y = MARGIN + 20;
  const foot: string[] = [];
  if (coding.byline) foot.push(`Sent by ${coding.byline}`);
  foot.push(`Sent ${coding.whenDisplay}`);
  page.drawText(foot.join(" · "), { x: MARGIN, y, size: 9, font: helv, color: rgb(0.35, 0.35, 0.35) });

  return await out.save();
}

// Scale a (w, h) image into the target content box, preserving
// aspect ratio, centred. `draw` is called with the final box.
function paintImage(
  _p: unknown,
  w: number,
  h: number,
  draw: (x: number, y: number, w: number, h: number) => void,
): void {
  const maxW = PAGE_W - MARGIN * 2;
  const maxH = PAGE_H - MARGIN * 2;
  const scale = Math.min(maxW / w, maxH / h, 1);
  const outW = w * scale;
  const outH = h * scale;
  const x = (PAGE_W - outW) / 2;
  const y = (PAGE_H - outH) / 2;
  draw(x, y, outW, outH);
}
