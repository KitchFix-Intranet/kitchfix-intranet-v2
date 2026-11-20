// Train 5 (reopen): the three-way "is this invoice still in
// QuickBooks?" question.
//
// Fix 1 (2026-11-20): reuse the engine's GET helper (`qboGetJson`)
// so the header is `X-API-Key` + the 8-second timeout the rest of
// the SC adapter already carries. A hand-rolled `Authorization:
// Bearer` would have come back not-ok from the live relay every
// time; the gate tests pass regardless of header, so the mistake
// cannot surface in test.
//
// Fix 2 (2026-11-20): "gone" is proven, not assumed. A 200 whose
// body carries a `Fault` object, or `{}`, or anything without a
// `QueryResponse` object, is `cannot_ask`, not `gone`. The only
// `gone` branch is: `res.ok` AND a `QueryResponse` object exists
// AND it carries no `Invoice[0]`.
//
// Fix 6 (2026-11-20): no escaping. QuickBooks does not treat `''`
// as an escape. Any DocNumber or Id that is not letters, digits
// and hyphens only is `cannot_ask` — we do not send it. The live
// values are `KF[A-Z]{3,}\d{6}[A-Z]{2,3}\d*` for DocNumber and
// numeric for Id.
//
// Reads go through `qboGetJson` -> `networkFetch`, so
// `SC_V2_OUTBOUND = 'off'` throws before the wire (the route maps
// that case to OUTBOUND_OFF_HAS_INVOICE earlier when a live ledger
// row exists). The `cannot_ask` branch still exists for mid-flight
// outages while outbound is on.

import { qboGetJson } from "@/lib/sc/billing/qboAdapter";

export type InvoiceCheck =
  | { kind: "gone"; checked: { byDocNumber: boolean; byId: boolean } }
  | { kind: "still_there"; docNumber: string | null; qboInvoiceId: string | null }
  | { kind: "cannot_ask"; reason: string };

export interface LedgerRef {
  qbo_doc_number: string | null;
  qbo_invoice_id: string | null;
}

// Letters, digits, hyphens. Any value failing this is not sent
// to QuickBooks. Covers today's shapes (DocNumber `KF.../\d*/`,
// Id numeric) with no quoting concern.
const SAFE = /^[A-Za-z0-9\-]+$/;

export async function readQboInvoiceCheck(
  ref: LedgerRef,
  opts?: {
    proxyBase?: string;
    realmId?: string;
    apiKey?: string;
    fetchImpl?: (url: string, apiKey: string) => Promise<{ ok: boolean; status: number; body: string }>;
  },
): Promise<InvoiceCheck> {
  const proxyBase = opts?.proxyBase ?? process.env.QBO_PROXY_BASE ?? "";
  const realmId   = opts?.realmId   ?? process.env.QBO_REALM_ID   ?? "";
  const apiKey    = opts?.apiKey    ?? process.env.QBO_PROXY_KEY  ?? "";
  // Fix 1: default fetch goes through the engine's qboGetJson so
  // the header (`X-API-Key`) and the 8-second timeout come with it.
  // Tests can inject a stub with the same { ok, status, body } shape.
  const fetchImpl = opts?.fetchImpl ?? qboGetJson;

  if (!ref.qbo_doc_number && !ref.qbo_invoice_id) {
    return { kind: "cannot_ask", reason: "ledger row has neither qbo_doc_number nor qbo_invoice_id" };
  }
  if (!proxyBase || !realmId || !apiKey) {
    return { kind: "cannot_ask", reason: "QBO relay credentials missing" };
  }

  const askDoc = !!ref.qbo_doc_number;
  const askId  = !!ref.qbo_invoice_id;

  // Fix 6: refuse unsafe values BEFORE any wire call.
  if (askDoc && !SAFE.test(String(ref.qbo_doc_number))) {
    return { kind: "cannot_ask", reason: "qbo_doc_number has unsafe characters" };
  }
  if (askId && !SAFE.test(String(ref.qbo_invoice_id))) {
    return { kind: "cannot_ask", reason: "qbo_invoice_id has unsafe characters" };
  }

  // One wire call per column. Returns "gone" only on proven-empty;
  // every other answer is "error" (mapped to cannot_ask below).
  async function queryOne(whereCol: "DocNumber" | "Id", value: string): Promise<"gone" | "found" | "error"> {
    const stripped = String(proxyBase).replace(/\/+$/, "");
    const text = `SELECT * FROM Invoice WHERE ${whereCol} = '${value}'`;
    const url = `${stripped}/v3/company/${encodeURIComponent(realmId)}/query?query=${encodeURIComponent(text)}&minorversion=75`;
    let res;
    try { res = await fetchImpl(url, apiKey); }
    catch { return "error"; }
    if (!res.ok) return "error";
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); }
    catch { return "error"; }
    // Fix 2: proven-gone. The response must:
    //   (a) be an object,
    //   (b) carry a `QueryResponse` object,
    //   (c) have no Invoice[0] on that object.
    // Anything else — including a 200 carrying a Fault, or an empty
    // body — is "error" (collapses to cannot_ask upstream).
    if (!parsed || typeof parsed !== "object") return "error";
    const p = parsed as Record<string, unknown>;
    if ("Fault" in p) return "error";
    const qr = (p as { QueryResponse?: unknown }).QueryResponse;
    if (!qr || typeof qr !== "object") return "error";
    const inv = (qr as { Invoice?: unknown[] }).Invoice;
    if (Array.isArray(inv) && inv.length > 0) return "found";
    return "gone";
  }

  const [docResult, idResult] = await Promise.all([
    askDoc ? queryOne("DocNumber", String(ref.qbo_doc_number)) : Promise.resolve<"gone" | "found" | "error">("gone"),
    askId  ? queryOne("Id",        String(ref.qbo_invoice_id))  : Promise.resolve<"gone" | "found" | "error">("gone"),
  ]);

  // Either side found -> still_there. Voided invoices (Balance=0,
  // PrivateNote "Voided") are still entities; the route carries the
  // voided-aware refusal copy.
  if (docResult === "found" || idResult === "found") {
    return {
      kind: "still_there",
      docNumber: ref.qbo_doc_number ?? null,
      qboInvoiceId: ref.qbo_invoice_id ?? null,
    };
  }
  // Any asked side errored -> cannot_ask.
  if ((askDoc && docResult === "error") || (askId && idResult === "error")) {
    return { kind: "cannot_ask", reason: `relay or parse failed (doc=${askDoc ? docResult : "n/a"}, id=${askId ? idResult : "n/a"})` };
  }
  return {
    kind: "gone",
    checked: { byDocNumber: askDoc, byId: askId },
  };
}
