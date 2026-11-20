import { test } from "node:test";
import { strict as assert } from "node:assert";
import { toMissing, labelFor } from "../draftListView.ts";
import { runReadyCheck } from "../readyCheck.ts";

// Train 2b fix-before-push #8 / section 4.6.
// Pure tests. No Supabase stand-in needed - the list-view's
// readiness pipeline is just these functions over runReadyCheck.

test("labelFor: field names map to plain words", () => {
  assert.equal(labelFor("vendor_id"), "Vendor");
  assert.equal(labelFor("type"), "Kind");
  assert.equal(labelFor("invoice_number"), "Number");
  assert.equal(labelFor("invoice_date"), "Date");
  assert.equal(labelFor("date_more_than_60"), "Date");
  assert.equal(labelFor("total_amount"), "Total");
  assert.equal(labelFor("gl_breakdown"), "Coding");
  assert.equal(labelFor("files"), "Page");
  assert.equal(labelFor("copy"), "Copy");
  assert.equal(labelFor("anything-else"), "Something");
});

test("toMissing: preserves the order of the first occurrence", () => {
  const errs = [
    { field: "total_amount", message: "" },
    { field: "vendor_id", message: "" },
    { field: "invoice_number", message: "" },
  ];
  assert.deepEqual(toMissing(errs), ["Total", "Vendor", "Number"]);
});

test("toMissing: no repeats (invoice_date and date_more_than_60 both map to Date)", () => {
  const errs = [
    { field: "invoice_date", message: "" },
    { field: "date_more_than_60", message: "" },
    { field: "total_amount", message: "" },
  ];
  assert.deepEqual(toMissing(errs), ["Date", "Total"]);
});

test("toMissing: capped at four", () => {
  const errs = [
    { field: "vendor_id", message: "" },
    { field: "invoice_number", message: "" },
    { field: "invoice_date", message: "" },
    { field: "total_amount", message: "" },
    { field: "gl_breakdown", message: "" },   // dropped - over the cap
    { field: "files", message: "" },           // dropped - over the cap
  ];
  const out = toMissing(errs);
  assert.equal(out.length, 4);
  assert.deepEqual(out, ["Vendor", "Number", "Date", "Total"]);
});

test("toMissing: empty in -> empty out", () => {
  assert.deepEqual(toMissing([]), []);
});

// ─── copy kinds through runReadyCheck ────────────────────────────

const READY_DRAFT = {
  id: "d1", account_key: "SITE", owner_email: "m@e",
  vendor_id: "v1", type: "invoice",
  invoice_number: "ABC-1", invoice_date: "2026-11-01",
  total_amount: 100,
  gl_breakdown: [{ code: "5000", name: "Food", amount: 100 }],
  answers: {}, screen: null,
  status: "draft", submission_id: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  discarded_at: null,
};
const activeSet = new Set(["5000"]);

test("runReadyCheck: same_invoice copy -> ready false + copy error", () => {
  const r = runReadyCheck({
    draft: READY_DRAFT,
    files: [{ id: "f", draft_id: "d1", submission_id: null, kind: "original",
              storage_path: "p", file_name: "f.pdf", mime_type: "application/pdf",
              size_bytes: 1, sha256: "x", page_count: 1, sort_order: 0,
              rotation: 0, uploaded_by: "m@e", created_at: "", removed_at: null }],
    activeCodesForSite: activeSet,
    vendorInScope: true,
    copyError: "same_invoice",
  });
  assert.equal(r.ready, false);
  const copy = r.errors.find((e) => e.field === "copy");
  assert.ok(copy);
  assert.equal(labelFor(copy.field), "Copy");
});

test("runReadyCheck: same_draft copy -> ready false + copy error", () => {
  const r = runReadyCheck({
    draft: READY_DRAFT,
    files: [{ id: "f", draft_id: "d1", submission_id: null, kind: "original",
              storage_path: "p", file_name: "f.pdf", mime_type: "application/pdf",
              size_bytes: 1, sha256: "x", page_count: 1, sort_order: 0,
              rotation: 0, uploaded_by: "m@e", created_at: "", removed_at: null }],
    activeCodesForSite: activeSet,
    vendorInScope: true,
    copyError: "same_draft",
  });
  assert.equal(r.ready, false);
  const copy = r.errors.find((e) => e.field === "copy");
  assert.ok(copy);
  assert.match(copy.message, /draft/);
});

test("runReadyCheck: no copy error -> ready true for a filled draft", () => {
  const r = runReadyCheck({
    draft: READY_DRAFT,
    files: [{ id: "f", draft_id: "d1", submission_id: null, kind: "original",
              storage_path: "p", file_name: "f.pdf", mime_type: "application/pdf",
              size_bytes: 1, sha256: "x", page_count: 1, sort_order: 0,
              rotation: 0, uploaded_by: "m@e", created_at: "", removed_at: null }],
    activeCodesForSite: activeSet,
    vendorInScope: true,
    copyError: null,
  });
  assert.equal(r.ready, true);
  assert.equal(r.errors.length, 0);
});

test("toMissing with a copy error at the end: no overflow", () => {
  const r = runReadyCheck({
    draft: READY_DRAFT,
    files: [{ id: "f", draft_id: "d1", submission_id: null, kind: "original",
              storage_path: "p", file_name: "f.pdf", mime_type: "application/pdf",
              size_bytes: 1, sha256: "x", page_count: 1, sort_order: 0,
              rotation: 0, uploaded_by: "m@e", created_at: "", removed_at: null }],
    activeCodesForSite: activeSet,
    vendorInScope: true,
    copyError: "same_invoice",
  });
  const missing = toMissing(r.errors);
  assert.ok(missing.includes("Copy"));
});
