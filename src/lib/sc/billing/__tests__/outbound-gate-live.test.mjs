// SC_V2_OUTBOUND=live.
//
// Every per-account decision runs the DB rule: exactly "live" is
// live; anything else is test (null, undefined, missing row, typo,
// wrong case, DB error).

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

test("gate live: outboundMode returns 'live'", () => {
  withEnv("live", () => assert.equal(outboundMode(), "live"));
});

test("gate live: DB row qbo_mode='live' resolves live", () => {
  withEnv("live", () => {
    assert.equal(resolveEffectiveQboMode({ qbo_mode: "live" }), "live");
  });
});

test("gate live: every other DB shape resolves test", () => {
  withEnv("live", () => {
    assert.equal(resolveEffectiveQboMode({ qbo_mode: "test" }), "test");
    assert.equal(resolveEffectiveQboMode({ qbo_mode: "LIVE" }), "test");
    assert.equal(resolveEffectiveQboMode({ qbo_mode: null }), "test");
    assert.equal(resolveEffectiveQboMode(null), "test");
    assert.equal(resolveEffectiveQboMode(undefined), "test");
  });
});
