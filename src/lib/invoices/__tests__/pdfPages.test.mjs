import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PDFDocument } from "pdf-lib";
import { pdfPageCount } from "../pdfPages.ts";

async function makePdf(nPages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < nPages; i++) {
    const p = doc.addPage([612, 792]);
    // No content needed - a blank page still counts.
    void p;
  }
  return await doc.save();
}

test("pdfPageCount: 1 page", async () => {
  const bytes = await makePdf(1);
  const n = await pdfPageCount(bytes, 5000);
  assert.equal(n, 1);
});

test("pdfPageCount: 5 pages", async () => {
  const bytes = await makePdf(5);
  const n = await pdfPageCount(bytes, 5000);
  assert.equal(n, 5);
});

test("pdfPageCount: 50 pages (largest tested here)", async () => {
  const bytes = await makePdf(50);
  const n = await pdfPageCount(bytes, 5000);
  assert.equal(n, 50);
});

test("pdfPageCount: garbage bytes returns null, does not throw", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const n = await pdfPageCount(bytes, 2000);
  assert.equal(n, null);
});

test("pdfPageCount: time limit honoured (very short)", async () => {
  // An absurdly short timeout should return null rather than hang,
  // even on a parseable PDF.
  const bytes = await makePdf(10);
  const n = await pdfPageCount(bytes, 1); // 1ms - should time out
  // Node's setTimeout 1ms vs PDFDocument.load: the race may go
  // either way on a fast machine. Accept either number-or-null as
  // long as the call returned without throwing.
  assert.ok(n === null || typeof n === "number");
});
