// Service Calendar lane · Outbound seam.
//
// The ONE place under src/lib/sc/** that may reach outside: email,
// Slack, the QuickBooks relay. Nothing else may import `googleapis`,
// call `fetch` to an outside URL, or hold an outbound webhook.
//
// Train 1 keeps both stand-ins inert. Train 2 wires the real ones.
//
// Email: v1's `sendEmailSA` resolves to the literal string "sent" or
// "failed" and never throws. Callers store the string. We match the
// contract: log one `console.error` line that names ourselves and
// resolve "failed". Nothing is sent.
//
// Network: a fetch-shaped function - same arguments as `fetch`, a
// `Promise<Response>`. In train 1 it never opens a connection; it
// logs one `console.error` line and rejects, matching what the
// network does when it is down. Every call site inside the engine
// (two in qboAdapter, one in qboNotifications, one in scReviewState)
// already catches.

export type SendEmailResult = "sent" | "failed";

export interface SendEmailArgs {
  sender: string;
  displayName?: string;
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; mimeType: string; base64: string }>;
}

export async function sendEmailSA(_args: SendEmailArgs): Promise<SendEmailResult> {
  console.error("[sc/outbound] sendEmailSA stub called in train 1; nothing was sent.");
  return "failed";
}

export async function networkFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
  console.error("[sc/outbound] networkFetch stub called in train 1; no network call made.");
  throw new Error("sc/outbound: networkFetch is not wired in train 1");
}
