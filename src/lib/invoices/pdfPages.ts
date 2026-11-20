// Server-only PDF page counter.
//
// Correction 6 (train 2 ruling): page count must not block a good
// file. If pdf-lib cannot open a PDF (locked, damaged trailer, very
// large), keep the file with page_count null as long as the first
// bytes said PDF.
//
// pdf-lib is already in the repo and marked `serverExternalPackages`
// in next.config.ts. We give it an explicit timeout so a pathological
// PDF cannot stall the finish route.

import { PDFDocument } from "pdf-lib";

const DEFAULT_TIMEOUT_MS = 8000;

export async function pdfPageCount(bytes: Uint8Array, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<number | null> {
  const task = (async () => {
    try {
      // `updateMetadata: false` and `throwOnInvalidObject: false` so
      // stubborn PDFs still open. We only need the page count.
      const doc = await PDFDocument.load(bytes, {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      const n = doc.getPageCount();
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
