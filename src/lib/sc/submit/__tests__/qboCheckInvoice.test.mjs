// Train 5: the three-way QBO invoice check.
//
// "gone" needs BOTH sides (DocNumber + Id) to return nothing when
// both are set. Either side "found" is "still_there". Any side
// erroring is "cannot_ask". Missing credentials or a ledger row
// with neither value is "cannot_ask" without hitting the wire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readQboInvoiceCheck } from "../qboCheckInvoice.ts";

const DOC = "KFACME260921MN";
const ID  = "9876543";
const ENV = { proxyBase: "https://relay.example/qbo", realmId: "999", apiKey: "k" };

function emptyResponse() {
  return { ok: true, status: 200, body: JSON.stringify({ QueryResponse: {} }) };
}
function foundResponse(docNumber, id) {
  return { ok: true, status: 200, body: JSON.stringify({
    QueryResponse: { Invoice: [{ Id: id, DocNumber: docNumber }] },
  }) };
}
function foundVoided(docNumber, id) {
  return { ok: true, status: 200, body: JSON.stringify({
    QueryResponse: { Invoice: [{ Id: id, DocNumber: docNumber, Balance: 0, PrivateNote: "Voided" }] },
  }) };
}
function errorResponse() {
  return { ok: false, status: 500, body: "boom" };
}
function parseFail() {
  return { ok: true, status: 200, body: "not json" };
}

test("both empty + both asked -> gone", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async () => emptyResponse() },
  );
  assert.equal(got.kind, "gone");
  assert.deepEqual(got.checked, { byDocNumber: true, byId: true });
});

test("DocNumber found, Id empty -> still_there", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async (url) =>
        url.includes("DocNumber") ? foundResponse(DOC, ID) : emptyResponse(),
    },
  );
  assert.equal(got.kind, "still_there");
  assert.equal(got.docNumber, DOC);
});

test("Id found, DocNumber empty -> still_there", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async (url) =>
        url.includes("Id%20") ? foundResponse(DOC, ID) : emptyResponse(),
    },
  );
  assert.equal(got.kind, "still_there");
});

test("voided invoice (Balance=0, PrivateNote Voided) -> still_there", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async () => foundVoided(DOC, ID) },
  );
  assert.equal(got.kind, "still_there");
});

test("either side errors -> cannot_ask", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async (url) =>
        url.includes("DocNumber") ? errorResponse() : emptyResponse(),
    },
  );
  assert.equal(got.kind, "cannot_ask");
});

test("parse fail -> cannot_ask", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async () => parseFail() },
  );
  assert.equal(got.kind, "cannot_ask");
});

test("neither qbo_doc_number nor qbo_invoice_id -> cannot_ask without hitting wire", async () => {
  let called = false;
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: null, qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => { called = true; return emptyResponse(); } },
  );
  assert.equal(got.kind, "cannot_ask");
  assert.equal(called, false);
});

test("missing credentials -> cannot_ask without hitting wire", async () => {
  let called = false;
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: ID },
    { proxyBase: "", realmId: "", apiKey: "", fetchImpl: async () => { called = true; return emptyResponse(); } },
  );
  assert.equal(got.kind, "cannot_ask");
  assert.equal(called, false);
});

test("DocNumber-only row: empty -> gone", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => emptyResponse() },
  );
  assert.equal(got.kind, "gone");
  assert.deepEqual(got.checked, { byDocNumber: true, byId: false });
});

test("Id-only row: empty -> gone", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: null, qbo_invoice_id: ID },
    { ...ENV, fetchImpl: async () => emptyResponse() },
  );
  assert.equal(got.kind, "gone");
  assert.deepEqual(got.checked, { byDocNumber: false, byId: true });
});

// ── Fix 6 (2026-11-20): unsafe characters never reach the wire.

test("DocNumber with a single quote -> cannot_ask without any wire call", async () => {
  let called = false;
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: "KF'TEST", qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => { called = true; return emptyResponse(); } },
  );
  assert.equal(got.kind, "cannot_ask");
  assert.equal(called, false);
});

test("Id with a space -> cannot_ask without any wire call", async () => {
  let called = false;
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: null, qbo_invoice_id: "123 456" },
    { ...ENV, fetchImpl: async () => { called = true; return emptyResponse(); } },
  );
  assert.equal(got.kind, "cannot_ask");
  assert.equal(called, false);
});

// ── Fix 2 (2026-11-20): gone must be proven, not assumed.

test("200 with a Fault body -> cannot_ask (NOT gone)", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => ({
      ok: true, status: 200,
      body: JSON.stringify({ Fault: { Error: [{ Message: "Something" }] } }),
    }) },
  );
  assert.equal(got.kind, "cannot_ask");
});

test("200 with an empty object body -> cannot_ask (no QueryResponse)", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => ({ ok: true, status: 200, body: JSON.stringify({}) }) },
  );
  assert.equal(got.kind, "cannot_ask");
});

test("200 with QueryResponse={} -> gone (proven-empty)", async () => {
  const got = await readQboInvoiceCheck(
    { qbo_doc_number: DOC, qbo_invoice_id: null },
    { ...ENV, fetchImpl: async () => ({ ok: true, status: 200, body: JSON.stringify({ QueryResponse: {} }) }) },
  );
  assert.equal(got.kind, "gone");
});
