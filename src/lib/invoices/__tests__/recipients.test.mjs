import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveRecipients } from "../recipients.ts";

// No real address appears in this file. Prompt §4: tests use
// `a@example.test` (the .test TLD is reserved for testing).

const AP = "ap@example.test";
const TEST_TO = "kevin-test@example.test";
const SUB = "sub@example.test";
const EXTRA = "cc1@example.test";
const EXTRA2 = "cc2@example.test";

test("test mode with INVOICES_V2_TEST_TO: to=[test], cc=[]; AP env ignored", () => {
  // Deliberately set the AP env to verify the test branch
  // structurally cannot return it.
  const r = resolveRecipients("test", { INVOICES_V2_TEST_TO: TEST_TO, INVOICE_AP_TO_EMAIL: AP, INVOICES_V2_CC: `${EXTRA},${EXTRA2}` }, SUB);
  assert.deepEqual(r, { ok: true, to: [TEST_TO], cc: [] });
});

test("test mode missing INVOICES_V2_TEST_TO -> code, never falls back", () => {
  const r = resolveRecipients("test", { INVOICE_AP_TO_EMAIL: AP }, SUB);
  assert.deepEqual(r, { ok: false, code: "missing_env:INVOICES_V2_TEST_TO" });
});

test("test mode blank INVOICES_V2_TEST_TO -> code", () => {
  const r = resolveRecipients("test", { INVOICES_V2_TEST_TO: "   " }, SUB);
  assert.deepEqual(r, { ok: false, code: "missing_env:INVOICES_V2_TEST_TO" });
});

test("live mode with AP env + submitter: cc includes submitter", () => {
  const r = resolveRecipients("live", { INVOICE_AP_TO_EMAIL: AP }, SUB);
  assert.deepEqual(r, { ok: true, to: [AP], cc: [SUB] });
});

test("live mode with AP + submitter + extra cc list (deduped, trimmed)", () => {
  const r = resolveRecipients("live", { INVOICE_AP_TO_EMAIL: AP, INVOICES_V2_CC: ` ${EXTRA} , ${EXTRA2} , ${EXTRA} ` }, SUB);
  assert.deepEqual(r, { ok: true, to: [AP], cc: [SUB, EXTRA, EXTRA2] });
});

test("live mode missing INVOICE_AP_TO_EMAIL -> code, never falls back to submitter or cc", () => {
  const r = resolveRecipients("live", { INVOICES_V2_CC: EXTRA }, SUB);
  assert.deepEqual(r, { ok: false, code: "missing_env:INVOICE_AP_TO_EMAIL" });
});

test("live mode submitter equals AP: not cc'd on itself", () => {
  const r = resolveRecipients("live", { INVOICE_AP_TO_EMAIL: AP }, AP);
  assert.deepEqual(r, { ok: true, to: [AP], cc: [] });
});

test("live mode cc list entry equals AP: dropped", () => {
  const r = resolveRecipients("live", { INVOICE_AP_TO_EMAIL: AP, INVOICES_V2_CC: AP }, SUB);
  assert.deepEqual(r, { ok: true, to: [AP], cc: [SUB] });
});

test("live mode null submitter + no cc list: cc=[]", () => {
  const r = resolveRecipients("live", { INVOICE_AP_TO_EMAIL: AP }, null);
  assert.deepEqual(r, { ok: true, to: [AP], cc: [] });
});
