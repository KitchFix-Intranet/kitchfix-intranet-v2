import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectKind } from "../fileKind.ts";

function withPrefix(prefix, n = 32) {
  const buf = new Uint8Array(n);
  buf.set(prefix, 0);
  return buf;
}

test("detectKind: PDF (%PDF)", () => {
  const buf = withPrefix([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
  const r = detectKind(buf);
  assert.equal(r.kind?.mime, "application/pdf");
  assert.equal(r.kind?.ext, "pdf");
  assert.equal(r.unaccepted, null);
});

test("detectKind: JPEG (FF D8 FF)", () => {
  const buf = withPrefix([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const r = detectKind(buf);
  assert.equal(r.kind?.mime, "image/jpeg");
  assert.equal(r.kind?.ext, "jpg");
});

test("detectKind: PNG", () => {
  const buf = withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = detectKind(buf);
  assert.equal(r.kind?.mime, "image/png");
});

test("detectKind: WebP (RIFF ... WEBP)", () => {
  const buf = withPrefix([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // size (any)
    0x57, 0x45, 0x42, 0x50, // WEBP
  ]);
  const r = detectKind(buf);
  assert.equal(r.kind?.mime, "image/webp");
});

test("detectKind: HEIC returns unaccepted", () => {
  const buf = withPrefix([
    0x00, 0x00, 0x00, 0x18, // ftyp box size
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x68, 0x65, 0x69, 0x63, // 'heic'
  ]);
  const r = detectKind(buf);
  assert.equal(r.kind, null);
  assert.equal(r.unaccepted, "heic");
});

test("detectKind: HEIC variants (heix, mif1)", () => {
  const heix = withPrefix([0,0,0,0x18, 0x66,0x74,0x79,0x70, 0x68,0x65,0x69,0x78]);
  assert.equal(detectKind(heix).unaccepted, "heic");
  const mif1 = withPrefix([0,0,0,0x18, 0x66,0x74,0x79,0x70, 0x6d,0x69,0x66,0x31]);
  assert.equal(detectKind(mif1).unaccepted, "heic");
});

test("detectKind: unknown prefix is nothing", () => {
  const buf = withPrefix([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  const r = detectKind(buf);
  assert.equal(r.kind, null);
  assert.equal(r.unaccepted, null);
});

test("detectKind: short buffer (<16 bytes) is nothing", () => {
  const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const r = detectKind(buf);
  assert.equal(r.kind, null);
});
