import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { outboundMode } from "../outboundGate.ts";

let original;

beforeEach(() => { original = process.env.INVOICES_V2_OUTBOUND; });
afterEach(() => {
  if (original === undefined) delete process.env.INVOICES_V2_OUTBOUND;
  else process.env.INVOICES_V2_OUTBOUND = original;
});

test("outboundMode: env unset -> off", () => {
  delete process.env.INVOICES_V2_OUTBOUND;
  assert.equal(outboundMode(), "off");
});

test("outboundMode: empty string -> off", () => {
  process.env.INVOICES_V2_OUTBOUND = "";
  assert.equal(outboundMode(), "off");
});

test("outboundMode: 'test' -> test", () => {
  process.env.INVOICES_V2_OUTBOUND = "test";
  assert.equal(outboundMode(), "test");
});

test("outboundMode: 'live' -> live", () => {
  process.env.INVOICES_V2_OUTBOUND = "live";
  assert.equal(outboundMode(), "live");
});

test("outboundMode: wrong case -> off", () => {
  process.env.INVOICES_V2_OUTBOUND = "TEST";
  assert.equal(outboundMode(), "off");
  process.env.INVOICES_V2_OUTBOUND = "Live";
  assert.equal(outboundMode(), "off");
});

test("outboundMode: typo -> off", () => {
  process.env.INVOICES_V2_OUTBOUND = "testing";
  assert.equal(outboundMode(), "off");
});
