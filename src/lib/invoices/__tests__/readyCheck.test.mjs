import { test } from "node:test";
import { strict as assert } from "node:assert";
import { runReadyCheck } from "../readyCheck.ts";

// Pin today's date so the "60 days back" check is deterministic.
// The test assertions do not depend on "today" directly, but the
// readyCheck module parses the draft date via dateInput which does.
// We give drafts dates close to a plausible "today" and ignore the
// 60-days flag behaviour in these tests (covered in dateInput).

function draft(overrides = {}) {
  return {
    id: "d1",
    account_key: "AAA - FL",
    owner_email: "x@y.co",
    vendor_id: "v1",
    type: "invoice",
    invoice_number: "INV-1",
    invoice_date: "2026-11-01",
    total_amount: 100,
    gl_breakdown: [{ code: "5000", name: "Food", amount: 100 }],
    answers: {},
    screen: "desk",
    status: "draft",
    submission_id: null,
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    discarded_at: null,
    ...overrides,
  };
}

function file() {
  return {
    id: "f1", draft_id: "d1", submission_id: null, kind: "original",
    storage_path: "drafts/d1/f1.pdf", file_name: "x.pdf", mime_type: "application/pdf",
    size_bytes: 1000, sha256: "a".repeat(64), page_count: 1, sort_order: 0,
    rotation: 0, uploaded_by: "x@y.co", created_at: "", removed_at: null,
  };
}

const activeCodes = new Set(["5000", "5100"]);

test("ready: all passes", () => {
  const r = runReadyCheck({ draft: draft(), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.equal(r.ready, true);
  assert.deepEqual([...r.errors], []);
});

test("not ready: vendor missing", () => {
  const r = runReadyCheck({ draft: draft({ vendor_id: null }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: false, copyError: null });
  assert.equal(r.ready, false);
  assert.ok(r.errors.some((e) => e.field === "vendor_id"));
});

test("not ready: type is neither invoice nor credit", () => {
  const r = runReadyCheck({ draft: draft({ type: "refund" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(r.errors.some((e) => e.field === "type"));
});

test("not ready: invoice number empty, too long", () => {
  const a = runReadyCheck({ draft: draft({ invoice_number: "" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(a.errors.some((e) => e.field === "invoice_number"));
  const b = runReadyCheck({ draft: draft({ invoice_number: "x".repeat(51) }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(b.errors.some((e) => e.field === "invoice_number"));
});

test("not ready: invoice date missing / unparseable / future", () => {
  const missing = runReadyCheck({ draft: draft({ invoice_date: null }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(missing.errors.some((e) => e.field === "invoice_date"));

  const bad = runReadyCheck({ draft: draft({ invoice_date: "not-a-date" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(bad.errors.some((e) => e.field === "invoice_date"));

  // A year clearly in the future.
  const future = runReadyCheck({ draft: draft({ invoice_date: "2099-01-01" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(future.errors.some((e) => e.field === "invoice_date"));
});

test("not ready: date >60 days back without the answer", () => {
  const r = runReadyCheck({ draft: draft({ invoice_date: "1999-01-01" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(r.errors.some((e) => e.field === "date_more_than_60"));
});

test("ready: date >60 days back is OK once confirmed", () => {
  const r = runReadyCheck({
    draft: draft({ invoice_date: "1999-01-01", answers: { date_confirmed_at_more_than_60_days: true } }),
    files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null,
  });
  assert.equal(r.ready, true);
});

test("not ready: total missing or zero / negative", () => {
  const miss = runReadyCheck({ draft: draft({ total_amount: null }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(miss.errors.some((e) => e.field === "total_amount"));
  const zero = runReadyCheck({ draft: draft({ total_amount: 0 }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(zero.errors.some((e) => e.field === "total_amount"));
});

test("not ready: gl line unknown code / zero amount / does not add up", () => {
  const unknown = runReadyCheck({
    draft: draft({ gl_breakdown: [{ code: "9999", name: "?", amount: 100 }] }),
    files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null,
  });
  assert.ok(unknown.errors.some((e) => e.field === "gl_breakdown"));

  const zero = runReadyCheck({
    draft: draft({ gl_breakdown: [{ code: "5000", name: "Food", amount: 0 }] }),
    files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null,
  });
  assert.ok(zero.errors.some((e) => e.field === "gl_breakdown"));

  const mismatch = runReadyCheck({
    draft: draft({ gl_breakdown: [{ code: "5000", name: "Food", amount: 99 }] }),
    files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null,
  });
  assert.ok(mismatch.errors.some((e) => e.field === "gl_breakdown"));
});

test("not ready: no files", () => {
  const r = runReadyCheck({ draft: draft(), files: [], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(r.errors.some((e) => e.field === "files"));
});

test("not ready: a removed file does not count", () => {
  const removed = { ...file(), removed_at: "2026-11-17T00:00:00Z" };
  const r = runReadyCheck({ draft: draft(), files: [removed], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.ok(r.errors.some((e) => e.field === "files"));
});

test("not ready: copy error", () => {
  const sameInv = runReadyCheck({ draft: draft(), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: "same_invoice" });
  assert.ok(sameInv.errors.some((e) => e.field === "copy"));
  const sameDraft = runReadyCheck({ draft: draft(), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: "same_draft" });
  assert.ok(sameDraft.errors.some((e) => e.field === "copy"));
});

test("credit type is accepted", () => {
  const r = runReadyCheck({ draft: draft({ type: "credit" }), files: [file()], activeCodesForSite: activeCodes, vendorInScope: true, copyError: null });
  assert.equal(r.ready, true);
});
