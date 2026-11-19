// SC_V2_OUTBOUND=test.
//
// Every account - including the four flagged qbo_mode='live' in the
// DB (TBR - FL, TXR - AZ, TBJ - FL, CIN - AZ) - resolves to test.
// Kevin's rehearsal mode: real sends, but every path lands on the
// engine's test routing.

import test from "node:test";
import assert from "node:assert/strict";
import { outboundMode } from "../../outboundGate.ts";
import { resolveEffectiveQboMode } from "../../submit/resolveQboMode.ts";

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

test("gate test: outboundMode returns 'test'", () => {
  withEnv("test", () => assert.equal(outboundMode(), "test"));
});

test("gate test: a DB row flagged live still resolves to test", () => {
  withEnv("test", () => {
    assert.equal(resolveEffectiveQboMode({ qbo_mode: "live" }), "test");
  });
});

test("gate test: every unreadable shape resolves to test", () => {
  withEnv("test", () => {
    assert.equal(resolveEffectiveQboMode({ qbo_mode: null }), "test");
    assert.equal(resolveEffectiveQboMode({ qbo_mode: "test" }), "test");
    assert.equal(resolveEffectiveQboMode(null), "test");
    assert.equal(resolveEffectiveQboMode(undefined), "test");
  });
});
