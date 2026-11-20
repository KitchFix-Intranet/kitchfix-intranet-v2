// Invoices V2 - Slack post. Server-only.
//
// §6: one post per invoice, 3-second timeout, never fails the
// send. No dollar amount; no address / name / token / body in
// the log. A missing SLACK_INVOICE_WEBHOOK skips the post.
//
// Second post: §6 says a second post only when a held invoice
// later delivers or gives up (correction 9). This file takes a
// text string; the caller composes it.

if (typeof window !== "undefined") {
  throw new Error("src/lib/invoices/slackPost.ts is server-only");
}

export type SlackResult = "sent" | "failed" | "skipped";

const TIMEOUT_MS = 3_000;

export async function postSlack(
  text: string,
  webhookUrl: string | null | undefined,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SlackResult> {
  if (!webhookUrl) return "skipped";
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error("slack_post_failed");
      return "failed";
    }
    return "sent";
  } catch {
    console.error("slack_post_failed");
    return "failed";
  } finally {
    clearTimeout(t);
  }
}
