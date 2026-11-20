// Pure RFC 5322 message builder. No I/O, no process.env, no
// node:crypto. Imports nothing but types. Safe to import from a
// Node test harness; also safe to touch from a browser bundle
// (its output is text).
//
// The server-only sender (src/lib/mail.ts) wraps this: it does
// the env read, JWT signing and HTTP calls. Everything input-
// validation + size + encoding lives here so it can be tested
// directly and separately.
//
// Return shape mirrors the sender's codes - a `{ ok: false, code }`
// return here is a `bad_input`-family answer the sender surfaces
// to its caller unchanged. The sender adds the missing_env /
// auth_failed / rejected / network cases around this.

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_RECIPIENTS = 100;

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  base64: string;
}

export interface BuildArgs {
  sender: string;
  displayName?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: AttachmentInput[];
  // Test-only: deterministic boundary token + Date header.
  _boundary?: string;
  _date?: string;
}

export type BuildResult =
  | { ok: true; message: string }
  | { ok: false; code: BuildErrorCode };

export type BuildErrorCode = "bad_input" | "too_large";

const CRLF = "\r\n";

// RFC 5322 bars CR + LF inside header values; any other control
// char is likewise refused to block header injection. Escape
// sequences only; the source stays plain ASCII.
const HEADER_CTL = /[\x00-\x1F\x7F]/;
// Standard base64 (RFC 4648). NOT base64url. Must be a whole
// number of groups, padding only at the end.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const NON_ASCII = /[^\x00-\x7F]/;

function bad(_why: string): BuildResult {
  // _why is unused so no diagnostic leaks the input. It is only
  // here so a reader sees which rule rejected.
  void _why;
  return { ok: false, code: "bad_input" };
}

function tooLarge(): BuildResult {
  return { ok: false, code: "too_large" };
}

function normList(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s === "") continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// Address sanitization: reject control chars and anything that
// looks like a header-injection attempt. Does NOT validate full
// RFC 5322 grammar; Gmail rejects malformed addresses at send
// time and that lands as `rejected`.
function sanitizeAddress(s: string): boolean {
  return s.length > 0 && !HEADER_CTL.test(s);
}

function sanitizeHeaderValue(s: string): boolean {
  return !HEADER_CTL.test(s);
}

// RFC 2047 encoded-word for a single text run. Used for subject,
// display-name, and attachment filename when the input is not
// pure ASCII. Output stays under 75 chars per segment; the
// caller joins segments with CRLF + space.
function encodeWord(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `=?utf-8?B?${b64}?=`;
}

function maybeEncode(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  // For short values this stays inside the 75-char per-word cap.
  // For long values (unlikely in subject / filename / display
  // name in this lane), split into runs of up to 36 UTF-8 bytes
  // each (36 * 4/3 base64 fits under 75 after the =?utf-8?B?
  // wrap).
  if (Buffer.byteLength(text, "utf8") <= 36) {
    return encodeWord(text);
  }
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const b = Buffer.byteLength(text[end], "utf8");
      if (bytes + b > 36) break;
      bytes += b;
      end += 1;
    }
    if (end === start) end = start + 1;
    pieces.push(encodeWord(text.slice(start, end)));
    start = end;
  }
  // Encoded-words are joined with CRLF + one space per RFC 2047.
  return pieces.join(`${CRLF} `);
}

function wrapBase64(b64: string): string {
  // RFC 2045 says base64 bodies wrap at 76 chars.
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 76) chunks.push(b64.slice(i, i + 76));
  return chunks.join(CRLF);
}

function pickBoundary(args: BuildArgs): string {
  if (args._boundary && !/[\s"\\(),/:;<=>?@[\]]/.test(args._boundary)) return args._boundary;
  return `kf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function toRfc5322Date(d: Date): string {
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${DOW[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function joinAddresses(list: string[]): string {
  if (list.length === 0) return "";
  return list.join(`,${CRLF} `);
}

function fromHeader(sender: string, displayName: string | undefined): string {
  if (!displayName) return sender;
  // RFC 5322 "quoted-string": any printable ASCII except
  // unescaped " and \. If the name has non-ASCII, use an
  // encoded-word instead of a quoted-string.
  const encoded = NON_ASCII.test(displayName)
    ? maybeEncode(displayName)
    : `"${displayName.replace(/["\\]/g, (m) => `\\${m}`)}"`;
  return `${encoded} <${sender}>`;
}

function filenameParam(filename: string): string {
  // Many mail clients accept RFC 2047 encoded-word inside a
  // quoted filename= parameter even though RFC 2231 is stricter;
  // this is what Gmail itself emits. Use quoted-string for pure
  // ASCII.
  return NON_ASCII.test(filename)
    ? maybeEncode(filename)
    : `"${filename.replace(/["\\]/g, (m) => `\\${m}`)}"`;
}

export function buildMessage(args: BuildArgs): BuildResult {
  // ---- 1. Sanitize string inputs -----------------------------
  if (typeof args.sender !== "string" || !sanitizeAddress(args.sender)) return bad("sender");
  if (args.displayName != null) {
    if (typeof args.displayName !== "string" || !sanitizeHeaderValue(args.displayName)) return bad("displayName");
  }
  if (typeof args.subject !== "string") return bad("subject-type");
  if (!sanitizeHeaderValue(args.subject)) return bad("subject-control");
  if (args.subject.trim() === "") return bad("subject-empty");
  if (args.replyTo != null) {
    if (typeof args.replyTo !== "string" || !sanitizeAddress(args.replyTo)) return bad("reply-to");
  }

  const toList = normList(args.to);
  const ccList = normList(args.cc);
  const bccList = normList(args.bcc);
  if (toList.length === 0) return bad("to-empty");
  for (const a of toList) if (!sanitizeAddress(a)) return bad("to-addr");
  for (const a of ccList) if (!sanitizeAddress(a)) return bad("cc-addr");
  for (const a of bccList) if (!sanitizeAddress(a)) return bad("bcc-addr");

  if (toList.length + ccList.length + bccList.length > MAX_RECIPIENTS) {
    return bad("too-many-recipients");
  }

  const atts = args.attachments ?? [];
  for (const a of atts) {
    if (!a || typeof a !== "object") return bad("attachment-shape");
    if (typeof a.filename !== "string" || a.filename === "" || !sanitizeHeaderValue(a.filename)) return bad("filename");
    if (typeof a.mimeType !== "string" || a.mimeType === "" || !sanitizeHeaderValue(a.mimeType)) return bad("mimeType");
    if (typeof a.base64 !== "string" || !BASE64_RE.test(a.base64) || a.base64.length % 4 !== 0) return bad("base64");
  }

  // ---- 2. Build headers --------------------------------------
  const headers: string[] = [];
  headers.push(`From: ${fromHeader(args.sender, args.displayName)}`);
  headers.push(`To: ${joinAddresses(toList)}`);
  if (ccList.length > 0) headers.push(`Cc: ${joinAddresses(ccList)}`);
  // Bcc is kept in the sent message; Gmail strips it on delivery
  // but still honours the address. See docs/GOTCHAS.md.
  if (bccList.length > 0) headers.push(`Bcc: ${joinAddresses(bccList)}`);
  if (args.replyTo) headers.push(`Reply-To: ${args.replyTo}`);
  headers.push(`Subject: ${maybeEncode(args.subject)}`);
  const date = args._date ?? toRfc5322Date(new Date());
  headers.push(`Date: ${date}`);
  headers.push("MIME-Version: 1.0");

  // ---- 3. Body + attachments ---------------------------------
  const htmlB64 = wrapBase64(Buffer.from(args.html ?? "", "utf8").toString("base64"));

  let message: string;
  if (atts.length === 0) {
    headers.push("Content-Type: text/html; charset=utf-8");
    headers.push("Content-Transfer-Encoding: base64");
    message = headers.join(CRLF) + CRLF + CRLF + htmlB64 + CRLF;
  } else {
    const boundary = pickBoundary(args);
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts: string[] = [];
    parts.push(
      [
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
      ].join(CRLF) + CRLF + CRLF + htmlB64,
    );
    for (const a of atts) {
      const nameParam = filenameParam(a.filename);
      const typeLine = `Content-Type: ${a.mimeType}; name=${nameParam}`;
      const dispLine = `Content-Disposition: attachment; filename=${nameParam}`;
      const wrapped = wrapBase64(a.base64);
      parts.push([typeLine, dispLine, "Content-Transfer-Encoding: base64"].join(CRLF) + CRLF + CRLF + wrapped);
    }
    const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
    message = headers.join(CRLF) + CRLF + CRLF + body;
  }

  // ---- 4. Size cap on the built bytes ------------------------
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) return tooLarge();

  return { ok: true, message };
}
