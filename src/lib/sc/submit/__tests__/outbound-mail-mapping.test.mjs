// `sendEmailSA` in test/live modes delegates to `sendSystemMail`.
// Mapping: ok:true -> "sent"; ok:false -> "failed". `off` mode is
// byte-identical to train 1 (returns "failed" with the known log
// line).
//
// `ok -> "sent"` can only be exercised against a live Google OAuth
// path; `sendEmailSA` does not accept a fetch dep today and we
// won't add a parameter just for the test. The PR body carries the
// gap. The failure side is pinned here: with no GOOGLE_* env vars
// set, `sendSystemMail` returns { ok:false, code:"missing_env:…" }
// and the lane must map that to "failed".

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendEmailSA } from "../../outbound.ts";

async function withOutbound(value, fn) {
  const prev = process.env.SC_V2_OUTBOUND;
  if (value === undefined) delete process.env.SC_V2_OUTBOUND;
  else process.env.SC_V2_OUTBOUND = value;
  try { await fn(); }
  finally {
    if (prev === undefined) delete process.env.SC_V2_OUTBOUND;
    else process.env.SC_V2_OUTBOUND = prev;
  }
}

async function withGoogleEnvCleared(fn) {
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pk = process.env.GOOGLE_PRIVATE_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  try { await fn(); }
  finally {
    if (sa !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = sa;
    if (pk !== undefined) process.env.GOOGLE_PRIVATE_KEY = pk;
  }
}

const sampleArgs = {
  sender: "test@example.test",
  displayName: "X",
  to: ["dest@example.test"],
  subject: "hello",
  html: "<p>hi</p>",
};

test("off mode returns 'failed' without touching sendSystemMail", async () => {
  await withOutbound("off", async () => {
    const r = await sendEmailSA(sampleArgs);
    assert.equal(r, "failed");
  });
});

test("test mode with no Google env vars maps the failure code to 'failed'", async () => {
  await withOutbound("test", async () => {
    await withGoogleEnvCleared(async () => {
      const r = await sendEmailSA(sampleArgs);
      // sendSystemMail returns { ok:false, code:"missing_env:…" }.
      // The lane must map that to "failed".
      assert.equal(r, "failed");
    });
  });
});

test("live mode with no Google env vars maps the failure code to 'failed'", async () => {
  await withOutbound("live", async () => {
    await withGoogleEnvCleared(async () => {
      const r = await sendEmailSA(sampleArgs);
      assert.equal(r, "failed");
    });
  });
});
