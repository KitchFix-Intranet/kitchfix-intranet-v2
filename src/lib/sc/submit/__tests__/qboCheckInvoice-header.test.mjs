// Train 5 fix 1 (2026-11-20): the check sends `X-API-Key`, not
// `Authorization: Bearer`. The default fetchImpl (`qboGetJson`)
// takes the header from the engine's own GET helper, so the
// convention is set in one file (`qboAdapter.ts`) and every SC
// call to the relay uses it.
//
// Test shape: drive the check with an environment that forces the
// default fetchImpl to be invoked — but stub the engine's inner
// `networkFetch` by setting SC_V2_OUTBOUND=test and overriding
// `fetch` for the duration of this test. Then assert on the
// header the stub received.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readQboInvoiceCheck } from "../qboCheckInvoice.ts";

test("default fetchImpl sends X-API-Key, not Authorization: Bearer", async () => {
  const prevOutbound = process.env.SC_V2_OUTBOUND;
  const prevBase     = process.env.QBO_PROXY_BASE;
  const prevRealm    = process.env.QBO_REALM_ID;
  const prevKey      = process.env.QBO_PROXY_KEY;
  process.env.SC_V2_OUTBOUND = "test";
  process.env.QBO_PROXY_BASE = "https://relay.example.test/qbo";
  process.env.QBO_REALM_ID   = "9999";
  process.env.QBO_PROXY_KEY  = "fake-key";

  // Replace the global fetch (networkFetch delegates to it under
  // test/live outbound). Capture the Request so we can assert on
  // headers, then return an empty-but-valid QueryResponse.
  const origFetch = globalThis.fetch;
  let seenHeaders = null;
  globalThis.fetch = async (input, init) => {
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ QueryResponse: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const got = await readQboInvoiceCheck({
      qbo_doc_number: "KFACME260921MN",
      qbo_invoice_id: "123",
    });
    assert.equal(got.kind, "gone");
    assert.ok(seenHeaders, "fetch was called");
    const xKey = seenHeaders["X-API-Key"];
    const auth = seenHeaders["authorization"] || seenHeaders["Authorization"];
    assert.equal(xKey, "fake-key", "header must be X-API-Key");
    assert.equal(auth, undefined, "no Authorization: Bearer header");
  } finally {
    globalThis.fetch = origFetch;
    if (prevOutbound === undefined) delete process.env.SC_V2_OUTBOUND; else process.env.SC_V2_OUTBOUND = prevOutbound;
    if (prevBase === undefined) delete process.env.QBO_PROXY_BASE; else process.env.QBO_PROXY_BASE = prevBase;
    if (prevRealm === undefined) delete process.env.QBO_REALM_ID; else process.env.QBO_REALM_ID = prevRealm;
    if (prevKey === undefined) delete process.env.QBO_PROXY_KEY; else process.env.QBO_PROXY_KEY = prevKey;
  }
});
