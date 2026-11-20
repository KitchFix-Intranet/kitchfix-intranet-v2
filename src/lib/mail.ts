// src/lib/mail.ts - shared foundation sender.
//
// One exported function: sendSystemMail. Every lane that sends an
// email (Service Calendar notifications, Invoices V2 AP sends)
// imports this and nothing else to reach Google. No switch here;
// each lane keeps its own gate and recipients. The sender takes
// what it is handed and sends it.
//
// What v1 learned, and we honour: the `sender` must be a mailbox
// in our own Google domain. The service account is granted
// domain-wide delegation for that domain only and the token's
// `sub` claim is `sender`; Google will refuse any outside
// address. No domain is named in this file.
//
// Return codes, the whole set:
//   missing_env:<NAME>  one of GOOGLE_SERVICE_ACCOUNT_EMAIL or
//                       GOOGLE_PRIVATE_KEY is absent.
//   bad_input           the message cannot be built: header
//                       injection, empty `to`, empty subject,
//                       non-base64 attachment, more than 100
//                       recipients across to/cc/bcc.
//   too_large           the built RFC 5322 bytes exceed 25 MB.
//   auth_failed         the OAuth token step answered non-2xx
//                       or returned a body we could not parse.
//   rejected            the send step answered non-2xx. Google
//                       refused the send after a good token.
//   network             a throw or a timeout at either step.
//
// On a failure, one `console.error` line carrying only the code.
// Never the address, display name, subject, filename, amount,
// token, key, or response body. Nothing on success.
//
// Why the upload URI, not the JSON `raw` endpoint:
//   POST /gmail/v1/users/me/messages/send with a base64url-
//   encoded `raw` field has been reported to fail above about
//   5 MB. Invoice PDFs can exceed that. This file POSTs the
//   RFC 5322 bytes directly to the upload URI with Content-Type
//   message/rfc822 and uploadType=media, which accepts up to the
//   enforced 25 MB cap in mailMessage.ts.

if (typeof window !== "undefined") {
  throw new Error("src/lib/mail.ts is server-only");
}

import { createSign } from "node:crypto";
import { buildMessage, MAX_MESSAGE_BYTES } from "./mailMessage";
import type { AttachmentInput } from "./mailMessage";

export const DEFAULT_TIMEOUT_MS = 20_000;
export { MAX_MESSAGE_BYTES };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export interface SendArgs {
  sender: string;
  displayName?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: AttachmentInput[];
}

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; code: string };

export interface SendDeps {
  // Test seam: inject fetch + clock. No test here touches the
  // network; a lane calling the real sender in production does
  // not pass this.
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export async function sendSystemMail(
  args: SendArgs,
  deps: SendDeps = {},
): Promise<SendResult> {
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!saEmail) return { ok: false, code: "missing_env:GOOGLE_SERVICE_ACCOUNT_EMAIL" };
  const pkRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!pkRaw) return { ok: false, code: "missing_env:GOOGLE_PRIVATE_KEY" };
  // v1's env form: literal `\n` escaped as backslash-n. The
  // replace is a no-op if the var is already stored with real
  // newlines.
  const privateKey = pkRaw.replace(/\\n/g, "\n");

  const built = buildMessage(args);
  if (!built.ok) {
    console.error(built.code);
    return { ok: false, code: built.code };
  }

  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ---- Token step ----
  let accessToken: string;
  try {
    accessToken = await getAccessToken({
      saEmail, privateKey, sender: args.sender,
      fetchFn, now, timeoutMs,
    });
  } catch (e) {
    const code = codeFromThrow(e);
    console.error(code);
    return { ok: false, code };
  }

  // ---- Send step ----
  try {
    const res = await fetchWithTimeout(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "message/rfc822",
      },
      body: built.message,
    }, fetchFn, timeoutMs);
    if (!res.ok) {
      console.error("rejected");
      return { ok: false, code: "rejected" };
    }
    let messageId = "";
    try {
      const body = await res.json();
      if (body && typeof body.id === "string") messageId = body.id;
    } catch {
      // Success without a parseable body: still ok, just no id.
    }
    return { ok: true, messageId };
  } catch (e) {
    const code = codeFromThrow(e);
    console.error(code);
    return { ok: false, code };
  }
}

// ─── JWT + token ──────────────────────────────────────────────

interface TokenArgs {
  saEmail: string;
  privateKey: string;
  sender: string;
  fetchFn: typeof fetch;
  now: () => number;
  timeoutMs: number;
}

async function getAccessToken(a: TokenArgs): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(a.now() / 1000);
  const claims = base64url(
    JSON.stringify({
      iss: a.saEmail,
      scope: GMAIL_SCOPE,
      aud: TOKEN_URL,
      sub: a.sender,
      iat,
      exp: iat + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  let assertion: string;
  try {
    const sig = createSign("RSA-SHA256").update(signingInput).sign(a.privateKey);
    assertion = `${signingInput}.${base64urlBytes(sig)}`;
  } catch {
    // A malformed GOOGLE_PRIVATE_KEY (not real PEM, missing
    // header/footer, or wrong line breaks) lands here. Google
    // would answer the token URL with 400; signalling the same
    // code keeps the failure shape uniform.
    throw taggedError("auth_failed");
  }

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  }, a.fetchFn, a.timeoutMs);

  if (!res.ok) throw taggedError("auth_failed");

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw taggedError("auth_failed");
  }
  if (!body || typeof (body as { access_token?: unknown }).access_token !== "string") {
    throw taggedError("auth_failed");
  }
  return (body as { access_token: string }).access_token;
}

// ─── fetch with timeout ───────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function taggedError(code: string): Error {
  const e = new Error(code);
  (e as unknown as { __mail_code: string }).__mail_code = code;
  return e;
}

function codeFromThrow(e: unknown): string {
  // A thrown error we tagged keeps its code. Everything else is
  // a timeout/fetch-throw and lands as network.
  if (e && typeof e === "object" && "__mail_code" in (e as object)) {
    const c = (e as { __mail_code: unknown }).__mail_code;
    if (typeof c === "string") return c;
  }
  return "network";
}

function base64url(s: string): string {
  return base64urlBytes(Buffer.from(s, "utf8"));
}

function base64urlBytes(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
