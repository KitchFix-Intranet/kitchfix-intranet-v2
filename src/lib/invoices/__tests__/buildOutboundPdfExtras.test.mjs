// Test: given an original that ends up as an extra (e.g. a
// WebP, which pdf-lib has no embedder for), two runs of
// buildOutboundPdf with the same input produce byte-identical
// extras. This is what lets deliverSend's retry path ship the
// SAME attachments as the first try without storing the extras
// anywhere between attempts.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildOutboundPdf } from "../buildOutboundPdf.ts";

function fakeSb(bytesByPath) {
  return {
    storage: {
      from: () => ({
        download: async (path) => {
          const b = bytesByPath.get(path);
          if (!b) return { data: null, error: { message: "not_found" } };
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          return {
            data: { arrayBuffer: async () => ab },
            error: null,
          };
        },
      }),
    },
  };
}

const coding = {
  isTest: false,
  title: "Invoice",
  site: "SITE",
  vendor: "Vendor",
  kindLabel: "Invoice",
  numberLabel: "Invoice number",
  number: "ABC-1",
  dateLabel: "Invoice date",
  dateDisplay: "11/20/2026",
  totalLabel: "Total",
  totalDisplay: "zero.zero",
  lines: [],
  byline: null,
  whenDisplay: "11/20/2026 10:00",
};

test("retry produces byte-identical extras from the same WebP original", async () => {
  // A small WebP-ish byte blob. The content does not have to be a
  // valid WebP for this test - buildOutboundPdf routes any
  // image/webp straight to extras without parsing.
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4C,
  ]);
  const path = "originals/abc/one.webp";
  const sb = fakeSb(new Map([[path, webp]]));

  const files = [{
    storage_path: path,
    mime_type: "image/webp",
    rotation: 0,
    file_name: "scan.webp",
  }];

  const first = await buildOutboundPdf(sb, files, coding);
  const second = await buildOutboundPdf(sb, files, coding);

  assert.equal(first.extras.length, 1);
  assert.equal(second.extras.length, 1);
  assert.equal(first.extras[0].filename, second.extras[0].filename);
  assert.equal(first.extras[0].mimeType, second.extras[0].mimeType);
  assert.equal(first.extras[0].base64, second.extras[0].base64);
});
