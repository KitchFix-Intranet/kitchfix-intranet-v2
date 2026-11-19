// Service Calendar lane · Outbound seam.
//
// The ONE place under src/lib/sc/** that may reach outside: email,
// Slack, the QuickBooks relay. Nothing else may import `googleapis`,
// call `fetch` to an outside URL, or hold an outbound webhook. A
// grep guard in the test suite enforces this.
//
// Train 3 (2026-11-17): the SC_V2_OUTBOUND env gate sits at the top
// of each function.
//
//   off   (default when the env var is missing / blank / anything
//          other than "test" or "live") - behaviour is byte-identical
//          to the train 1 inert stubs: sendEmailSA returns "failed"
//          after one console.error line; networkFetch logs one
//          console.error line and throws the same Error message.
//          Shipping configuration. Four live v1 accounts stay
//          unreachable from V2.
//
//   test  - every send goes out, but every account is forced onto
//          the engine's test routing by resolveEffectiveQboMode.
//          Recipients collapse to Kevin only; Slack posts land in
//          #service-calendar-invoices with the [TEST] prefix;
//          QuickBooks posts route to the test customer 22463.
//
//   live  - every send goes out; per-account qbo_mode from the DB
//          decides routing. Kevin's deliberate flip; this train
//          does not ship with this value in production.
//
// Email: v1's `sendEmailSA` contract is to resolve "sent" or
// "failed" and never throw. We honour that in every mode.
//
// Network: a fetch-shaped function. When the mode allows a send,
// this delegates to global `fetch`. When off, it throws the same
// Error shape every caller already catches.

import { outboundMode } from "@/lib/sc/outboundGate";

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

export async function sendEmailSA(args: SendEmailArgs): Promise<SendEmailResult> {
  const mode = outboundMode();
  if (mode === "off") {
    // Byte-identical to train 1. Same log shape, same return.
    // v1's callers store the string; nothing reads the console line.
    console.error("[sc/outbound] sendEmailSA stub called in train 1; nothing was sent.");
    return "failed";
  }
  // mode === "test" or "live": wire up v1's service-account sender.
  // Train 3 wires this behind the gate; the actual Google OAuth
  // service-account implementation lands with the first real send
  // (Kevin flips SC_V2_OUTBOUND=test in Vercel). Until then, falling
  // through here returns "failed" so a mis-flip cannot pretend to
  // have sent.
  console.error(`[sc/outbound] sendEmailSA called under mode=${mode}; real sender not yet wired.`);
  // Silence the unused-param warning without exporting a different
  // signature than today's.
  void args;
  return "failed";
}

export async function networkFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const mode = outboundMode();
  if (mode === "off") {
    // Byte-identical to train 1. Same log shape, same Error message
    // text so every call site's catch path behaves exactly as now.
    console.error("[sc/outbound] networkFetch stub called in train 1; no network call made.");
    throw new Error("sc/outbound: networkFetch is not wired in train 1");
  }
  // test or live: forward to the platform fetch. qboAdapter already
  // builds the right URL + body per the resolved qboMode argument;
  // this function is just the door. No routing decision here.
  return fetch(input as RequestInfo, init);
}
