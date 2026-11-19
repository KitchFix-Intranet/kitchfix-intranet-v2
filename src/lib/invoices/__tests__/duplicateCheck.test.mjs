import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isCopyCandidate } from "../duplicateCheck.ts";

function draft(overrides = {}) {
  return {
    id: "d1",
    account_key: "AAA - FL",
    vendor_id: "v1",
    type: "invoice",
    invoice_number: "123",
    answers: {},
    ...overrides,
  };
}

function cand(overrides = {}) {
  return {
    id: "c1",
    account_key: "AAA - FL",
    vendor_id: "v1",
    type: "invoice",
    invoice_number: "123",
    ...overrides,
  };
}

test("copy: same site, vendor, kind, number -> true", () => {
  assert.equal(isCopyCandidate(draft(), cand()), true);
});

test("copy: normalized number variants match", () => {
  assert.equal(isCopyCandidate(draft({ invoice_number: "#00123" }), cand({ invoice_number: "123" })), true);
  assert.equal(isCopyCandidate(draft({ invoice_number: "123" }), cand({ invoice_number: "#00123" })), true);
  assert.equal(isCopyCandidate(draft({ invoice_number: "00123" }), cand({ invoice_number: "#123" })), true);
});

test("copy: another site is NOT a copy", () => {
  assert.equal(isCopyCandidate(draft(), cand({ account_key: "BBB - FL" })), false);
});

test("copy: different vendor is NOT a copy", () => {
  assert.equal(isCopyCandidate(draft(), cand({ vendor_id: "v2" })), false);
});

test("copy: a credit with an invoice's number is NOT a copy", () => {
  assert.equal(isCopyCandidate(draft({ type: "invoice" }), cand({ type: "credit" })), false);
  assert.equal(isCopyCandidate(draft({ type: "credit" }), cand({ type: "invoice" })), false);
});

test("copy: same kind, both credit, same number -> copy", () => {
  assert.equal(isCopyCandidate(draft({ type: "credit" }), cand({ type: "credit" })), true);
});

test("copy: `is_different_invoice` answer waives the check", () => {
  assert.equal(
    isCopyCandidate(draft({ answers: { is_different_invoice: true } }), cand()),
    false,
  );
});

test("copy: `is_credit_for` answer waives the check", () => {
  assert.equal(
    isCopyCandidate(draft({ answers: { is_credit_for: "some-submission-id" } }), cand()),
    false,
  );
});

test("copy: candidate id equal to draft id is not a copy (self)", () => {
  assert.equal(isCopyCandidate(draft(), cand({ id: "d1" })), false);
});

test("copy: empty number on either side -> not a copy", () => {
  assert.equal(isCopyCandidate(draft({ invoice_number: "" }), cand()), false);
  assert.equal(isCopyCandidate(draft(), cand({ invoice_number: null })), false);
});

test("copy: null vendor on either side -> not a copy", () => {
  assert.equal(isCopyCandidate(draft({ vendor_id: null }), cand()), false);
  assert.equal(isCopyCandidate(draft(), cand({ vendor_id: null })), false);
});
