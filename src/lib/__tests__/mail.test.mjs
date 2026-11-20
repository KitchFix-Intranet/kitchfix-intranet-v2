import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { sendSystemMail } from "../mail.ts";

// Generate one RSA keypair for every happy-path test. The public
// key is never used: the injected fetch does not verify the JWT.
// The private key is passed through process.env.GOOGLE_PRIVATE_KEY
// in both the real line-break form and the v1 escaped form.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const BASE_ARGS = Object.freeze({
  sender: "sender@example.com",
  to: "to@example.com",
  subject: "A subject",
  html: "<p>hello</p>",
});

// ─── env + console harness ────────────────────────────────────

let errorLog;
const origError = console.error;

beforeEach(() => {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "sa@example.com";
  process.env.GOOGLE_PRIVATE_KEY = privateKey;
  errorLog = [];
  console.error = (...args) => { errorLog.push(args.map(String).join(" ")); };
});

afterEach(() => {
  console.error = origError;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
});

// A tiny stub fetch. Recording lets a test assert request shape.
function stubFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    if (r instanceof Error) throw r;
    if (r === "timeout") {
      // Hang until the caller aborts. Resolve a rejected promise
      // when AbortSignal fires so the sender sees the abort as a
      // throw.
      return await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return r;
  };
  return { fn, calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Every error log line, across the test, must contain only the
// code: no addresses, no subjects, no filenames, no response body.
function assertCleanLog(code) {
  for (const line of errorLog) {
    assert.equal(line, code, `error log must carry only the code, got: ${line}`);
    assert.doesNotMatch(line, /@example\.com/, "no address in log");
    assert.doesNotMatch(line, /sender|to@|subject|hello|body|token/i, "no private substring in log");
  }
}

// ─── missing env ──────────────────────────────────────────────

test("missing env: GOOGLE_SERVICE_ACCOUNT_EMAIL", async () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const { fn, calls } = stubFetch(() => { throw new Error("no fetch expected"); });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "missing_env:GOOGLE_SERVICE_ACCOUNT_EMAIL" });
  assert.equal(calls.length, 0, "no network call");
  // Missing env is a presence check before buildMessage; nothing logged.
  assert.deepEqual(errorLog, []);
});

test("missing env: GOOGLE_PRIVATE_KEY", async () => {
  delete process.env.GOOGLE_PRIVATE_KEY;
  const { fn, calls } = stubFetch(() => { throw new Error("no fetch expected"); });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "missing_env:GOOGLE_PRIVATE_KEY" });
  assert.equal(calls.length, 0);
});

// ─── bad_input surface (one representative; the full matrix
// lives in mailMessage.test.mjs) ──────────────────────────────

test("bad_input is surfaced + logged + no network call", async () => {
  const { fn, calls } = stubFetch(() => { throw new Error("no fetch expected"); });
  const r = await sendSystemMail({ ...BASE_ARGS, subject: "" }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "bad_input" });
  assert.equal(calls.length, 0);
  assertCleanLog("bad_input");
});

test("too_large is surfaced + logged + no network call", async () => {
  const { fn, calls } = stubFetch(() => { throw new Error("no fetch expected"); });
  const bytes = Buffer.alloc(26 * 1024 * 1024, 0x61);
  const r = await sendSystemMail({
    ...BASE_ARGS,
    attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", base64: bytes.toString("base64") }],
  }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "too_large" });
  assert.equal(calls.length, 0);
  assertCleanLog("too_large");
});

// ─── happy path ──────────────────────────────────────────────

test("good token + good send -> ok + id, upload URI is used", async () => {
  const { fn, calls } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse(200, { access_token: "ya29.test", expires_in: 3599, token_type: "Bearer" });
    }
    if (url.startsWith("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media")) {
      return jsonResponse(200, { id: "msg_abc123" });
    }
    throw new Error("unexpected URL");
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: true, messageId: "msg_abc123" });
  assert.equal(calls.length, 2);
  const [tokenCall, sendCall] = calls;
  assert.equal(tokenCall.init.method, "POST");
  assert.match(tokenCall.init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer|grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer/);
  assert.match(tokenCall.init.body, /&assertion=[^.]+\.[^.]+\.[^&]+/, "assertion is a three-part JWT");
  assert.equal(sendCall.init.method, "POST");
  assert.equal(sendCall.init.headers["Content-Type"], "message/rfc822");
  assert.equal(sendCall.init.headers.Authorization, "Bearer ya29.test");
  assert.ok(typeof sendCall.init.body === "string" && sendCall.init.body.startsWith("From: "));
  assert.deepEqual(errorLog, [], "no log on success");
});

test("escaped-\\n private key form works (v1 shape)", async () => {
  // Store with literal backslash-n sequences the way Vercel env
  // commonly holds a PEM.
  process.env.GOOGLE_PRIVATE_KEY = privateKey.replace(/\r?\n/g, "\\n");
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse(200, { access_token: "ok" });
    return jsonResponse(200, { id: "msg_1" });
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: true, messageId: "msg_1" });
});

// ─── failure cases on the sender ─────────────────────────────

test("token step non-2xx -> auth_failed", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse(401, { error: "invalid_grant" });
    throw new Error("send not expected");
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "auth_failed" });
  assertCleanLog("auth_failed");
});

test("token step unparseable body -> auth_failed", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    }
    throw new Error("send not expected");
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "auth_failed" });
});

test("send step non-2xx -> rejected", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse(200, { access_token: "t" });
    return jsonResponse(400, { error: { message: "bad" } });
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "rejected" });
  assertCleanLog("rejected");
});

test("thrown fetch at token step -> network", async () => {
  const { fn } = stubFetch(() => new Error("connection reset"));
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "network" });
  assertCleanLog("network");
});

test("thrown fetch at send step -> network", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse(200, { access_token: "t" });
    return new Error("send threw");
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "network" });
  assertCleanLog("network");
});

test("timeout at token step -> network", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return "timeout";
    throw new Error("send not expected");
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, code: "network" });
});

test("timeout at send step -> network", async () => {
  const { fn } = stubFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse(200, { access_token: "t" });
    return "timeout";
  });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, code: "network" });
});

test("malformed GOOGLE_PRIVATE_KEY -> auth_failed before network", async () => {
  process.env.GOOGLE_PRIVATE_KEY = "not a real PEM";
  const { fn, calls } = stubFetch(() => { throw new Error("no fetch expected"); });
  const r = await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.deepEqual(r, { ok: false, code: "auth_failed" });
  assert.equal(calls.length, 0, "signing fails before any network call");
  assertCleanLog("auth_failed");
});

// ─── JWT shape smoke ─────────────────────────────────────────

test("JWT claims: iss=sa, aud=token url, scope=gmail.send, sub=sender", async () => {
  let assertion = "";
  const { fn } = stubFetch((url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      // Pull the assertion out of the x-www-form-urlencoded body.
      const m = String(init.body).match(/assertion=([^&]+)/);
      if (m) assertion = decodeURIComponent(m[1]);
      return jsonResponse(200, { access_token: "t" });
    }
    return jsonResponse(200, { id: "m" });
  });
  await sendSystemMail({ ...BASE_ARGS }, { fetch: fn });
  assert.ok(assertion, "assertion captured");
  const [, claimsB64] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(claimsB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  assert.equal(claims.iss, "sa@example.com");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/gmail.send");
  assert.equal(claims.sub, "sender@example.com");
  assert.equal(typeof claims.iat, "number");
  assert.equal(claims.exp, claims.iat + 3600);
});
