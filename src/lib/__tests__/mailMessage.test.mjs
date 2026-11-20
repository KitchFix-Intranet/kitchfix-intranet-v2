import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildMessage, MAX_MESSAGE_BYTES, MAX_RECIPIENTS,
} from "../mailMessage.ts";

// All test addresses use example.com - the repo is public, no
// real address appears anywhere in the codebase.

const BASE_ARGS = Object.freeze({
  sender: "sender@example.com",
  to: "to1@example.com",
  subject: "Plain subject",
  html: "<p>body</p>",
  _boundary: "kf_test_boundary",
  _date: "Thu, 20 Nov 2026 19:00:00 +0000",
});

// ─── happy paths ──────────────────────────────────────────────

test("one recipient, no attachment, plain ASCII: valid message", () => {
  const r = buildMessage({ ...BASE_ARGS });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  // Headers present
  assert.match(msg, /^From: sender@example\.com\r\n/m);
  assert.match(msg, /^To: to1@example\.com\r\n/m);
  assert.match(msg, /^Subject: Plain subject\r\n/m);
  assert.match(msg, /^Date: Thu, 20 Nov 2026 19:00:00 \+0000\r\n/m);
  assert.match(msg, /^MIME-Version: 1\.0\r\n/m);
  // No attachments -> text/html directly, base64 body
  assert.match(msg, /^Content-Type: text\/html; charset=utf-8\r\n/m);
  assert.match(msg, /^Content-Transfer-Encoding: base64\r\n/m);
  // Body matches the HTML
  const b64 = Buffer.from("<p>body</p>", "utf8").toString("base64");
  assert.ok(msg.includes(b64), "html body is base64-encoded");
  // Not multipart
  assert.ok(!/multipart\/mixed/.test(msg), "no multipart with 0 attachments");
});

test("many to + cc + bcc: three address headers, one Bcc, no dup", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    to: ["a@example.com", "b@example.com", "a@example.com"], // duplicate drops
    cc: ["c@example.com", "d@example.com"],
    bcc: ["e@example.com"],
  });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /^To: a@example\.com,\r\n b@example\.com\r\n/m);
  assert.match(msg, /^Cc: c@example\.com,\r\n d@example\.com\r\n/m);
  assert.match(msg, /^Bcc: e@example\.com\r\n/m);
  // Count To/Cc/Bcc occurrences at line start - each exactly once.
  assert.equal((msg.match(/^To:/gm) ?? []).length, 1);
  assert.equal((msg.match(/^Cc:/gm) ?? []).length, 1);
  assert.equal((msg.match(/^Bcc:/gm) ?? []).length, 1);
});

test("display name (ASCII): quoted-string in From", () => {
  const r = buildMessage({ ...BASE_ARGS, displayName: "Sender Name" });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /^From: "Sender Name" <sender@example\.com>\r\n/m);
});

test("display name with quotes: escaped inside quoted-string", () => {
  const r = buildMessage({ ...BASE_ARGS, displayName: `Name "with" quotes` });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /^From: "Name \\"with\\" quotes" <sender@example\.com>\r\n/m);
});

test("reply-to: Reply-To header added", () => {
  const r = buildMessage({ ...BASE_ARGS, replyTo: "reply@example.com" });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /^Reply-To: reply@example\.com\r\n/m);
});

test("non-ASCII subject, display name and filename: RFC 2047 encoded", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    subject: "Café invoice",
    displayName: "Café KitchFix",
    attachments: [
      { filename: "café.pdf", mimeType: "application/pdf", base64: Buffer.from("PDF").toString("base64") },
    ],
  });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /^Subject: =\?utf-8\?B\?/m);
  assert.match(msg, /^From: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <sender@example\.com>\r\n/m);
  // Filename encoded both in Content-Type name= and Content-Disposition filename=
  const count = (msg.match(/=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/g) ?? []).length;
  assert.ok(count >= 4, `expected >= 4 encoded-word uses, got ${count}`);
});

test("two attachments: boundary, both parts decode back to their bytes", () => {
  const a1 = Buffer.from("first attachment bytes", "utf8");
  const a2 = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [
      { filename: "one.txt", mimeType: "text/plain", base64: a1.toString("base64") },
      { filename: "two.pdf", mimeType: "application/pdf", base64: a2.toString("base64") },
    ],
  });
  assert.equal(r.ok, true);
  const msg = r.ok ? r.message : "";
  assert.match(msg, /Content-Type: multipart\/mixed; boundary="kf_test_boundary"\r\n/);
  // Three parts: HTML + two attachments; boundary markers.
  const boundaryStarts = (msg.match(/\r\n--kf_test_boundary\r\n/g) ?? []).length;
  assert.equal(boundaryStarts, 3, "three part-start boundaries");
  assert.ok(msg.endsWith("\r\n--kf_test_boundary--\r\n"), "closing boundary at end");
  // Attachment 1 and 2 round-trip
  for (const bytes of [a1, a2]) {
    const b64 = bytes.toString("base64");
    const wrapped = wrapAt76(b64);
    assert.ok(msg.includes(wrapped), "attachment body appears wrapped at 76");
  }
});

// ─── bad_input: every rule, and no network path can be reached
// because this builder makes no network calls. ────────────────

test("bad_input: empty to", () => {
  const r = buildMessage({ ...BASE_ARGS, to: [] });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: empty subject", () => {
  const r = buildMessage({ ...BASE_ARGS, subject: "" });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: whitespace-only subject", () => {
  const r = buildMessage({ ...BASE_ARGS, subject: "   " });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in sender", () => {
  const r = buildMessage({ ...BASE_ARGS, sender: "sender@example.com\r\nBcc: injected@example.com" });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in displayName", () => {
  const r = buildMessage({ ...BASE_ARGS, displayName: "Name\nInjected" });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in a to-address", () => {
  const r = buildMessage({ ...BASE_ARGS, to: ["ok@example.com", "bad@example.com\r\nX: y"] });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CR in replyTo", () => {
  const r = buildMessage({ ...BASE_ARGS, replyTo: "reply@example.com\r" });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in subject", () => {
  const r = buildMessage({ ...BASE_ARGS, subject: "Hi\r\nBcc: x" });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in filename", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [{ filename: "a\r\nb.pdf", mimeType: "application/pdf", base64: Buffer.from("x").toString("base64") }],
  });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: CRLF in mimeType", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf\r\n", base64: Buffer.from("x").toString("base64") }],
  });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: attachment base64 is not base64", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf", base64: "not-base-64!@#" }],
  });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: attachment base64 has wrong padding", () => {
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [{ filename: "a.pdf", mimeType: "application/pdf", base64: "ABC" }], // length not divisible by 4
  });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
});

test("bad_input: >100 recipients across to+cc+bcc", () => {
  const to = [];
  for (let i = 0; i < 101; i++) to.push(`to${i}@example.com`);
  const r = buildMessage({ ...BASE_ARGS, to });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
  // exactly 100 is OK
  const to100 = [];
  for (let i = 0; i < 100; i++) to100.push(`to${i}@example.com`);
  const r2 = buildMessage({ ...BASE_ARGS, to: to100 });
  assert.equal(r2.ok, true);
  assert.equal(MAX_RECIPIENTS, 100);
});

// ─── too_large ────────────────────────────────────────────────

test("too_large: built message exceeds MAX_MESSAGE_BYTES", () => {
  // A ~26 MB attachment pushes the message past 25 MB.
  const bytes = Buffer.alloc(26 * 1024 * 1024, 0x61); // 'a' x 26M
  const b64 = bytes.toString("base64");
  const r = buildMessage({
    ...BASE_ARGS,
    attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", base64: b64 }],
  });
  assert.deepEqual(r, { ok: false, code: "too_large" });
});

test("MAX_MESSAGE_BYTES is 25 MiB", () => {
  assert.equal(MAX_MESSAGE_BYTES, 25 * 1024 * 1024);
});

// ─── helper ───────────────────────────────────────────────────

function wrapAt76(s) {
  const chunks = [];
  for (let i = 0; i < s.length; i += 76) chunks.push(s.slice(i, i + 76));
  return chunks.join("\r\n");
}
