// SC_V2_OUTBOUND=off (shipping configuration).
//
// Two acceptance assertions:
//   1. sendEmailSA returns the literal "failed" (same shape today).
//   2. networkFetch throws the same Error message shape every call
//      site already catches today.
// Plus: every unknown value - undefined, "", "OFF", "maybe",
// "LIVE" (wrong case) - resolves to off, not to a send.

import test from "node:test";
import assert from "node:assert/strict";
import { outboundMode } from "../../outboundGate.ts";
import { sendEmailSA, networkFetch } from "../../outbound.ts";

function withEnv(value, fn) {
  const was = process.env.SC_V2_OUTBOUND;
  if (value === null) delete process.env.SC_V2_OUTBOUND;
  else process.env.SC_V2_OUTBOUND = value;
  try { return fn(); }
  finally {
    if (was === undefined) delete process.env.SC_V2_OUTBOUND;
    else process.env.SC_V2_OUTBOUND = was;
  }
}

test("gate off: unset env resolves to off", () => {
  withEnv(null, () => assert.equal(outboundMode(), "off"));
});

test("gate off: empty string resolves to off", () => {
  withEnv("", () => assert.equal(outboundMode(), "off"));
});

test("gate off: a typo resolves to off (case-sensitive)", () => {
  withEnv("TEST", () => assert.equal(outboundMode(), "off"));
  withEnv("LIVE", () => assert.equal(outboundMode(), "off"));
  withEnv("OFF",  () => assert.equal(outboundMode(), "off"));
  withEnv("maybe", () => assert.equal(outboundMode(), "off"));
});

test("gate off: sendEmailSA returns 'failed', no exception", async () => {
  await withEnv(null, async () => {
    const r = await sendEmailSA({
      sender: "noreply@example.com",
      to: "someone@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    assert.equal(r, "failed");
  });
});

test("gate off: networkFetch throws the train-1 Error message", async () => {
  await withEnv(null, async () => {
    await assert.rejects(
      () => networkFetch("https://example.invalid/"),
      (err) => err instanceof Error && err.message === "sc/outbound: networkFetch is not wired in train 1",
    );
  });
});
