// Train 6: one lane helper for the base address every notification
// link is built from. NEXT_PUBLIC_APP_BASE_URL is not set on V2's
// Vercel project today (Chat-Claude confirmed the six-setting list);
// the engine's two link builders used it unconditionally and would
// have emitted `undefined/service/review?...`.
//
// Order:
//   1. SC_APP_BASE_URL  - the lane's own server setting.
//   2. the production domain of V2, hardcoded.
//
// Never returns "" or "undefined". Any callsite that composes a URL
// starts with the output of this function, so a missing env var
// still produces a live link to production.

const V2_PRODUCTION_URL = "https://kitchfix-intranet-v2.vercel.app";

export function appBaseUrl(): string {
  const v = (process.env.SC_APP_BASE_URL ?? "").trim();
  if (v) return v.replace(/\/+$/, "");
  return V2_PRODUCTION_URL;
}
