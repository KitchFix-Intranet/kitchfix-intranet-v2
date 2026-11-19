// Shared tiny helpers for the panel blocks. T2 §1 widens postJson so
// every save in the lane runs through one safe path: a dropped
// connection is a caught outcome, a timeout aborts the request, and
// the three failure cases carry one plain sentence each. Nothing in
// here renders - the hook in useSaveWithRefresh.ts maps the outcome
// and the caller puts the sentence beside the control.

export type SaveKind = "ok" | "no-reply" | "server" | "refused";

export type SaveOutcome = {
  ok: boolean;
  status: number;
  data: unknown;
  kind: SaveKind;
  // Raw server body text on a 5xx so the hook can forward it to the
  // console. Never rendered to the page.
  rawText?: string;
};

export type PostJsonOptions = {
  // Ordinary saves time out after 30 s so the control is never frozen
  // waiting on a dropped socket. Long jobs (matcher, intake, backfills,
  // the one-time migrate) pass `null` to wait as long as the server
  // holds the connection.
  timeoutMs?: number | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export async function postJson(
  url: string,
  body: unknown,
  opts?: PostJsonOptions
): Promise<SaveOutcome> {
  const timeoutMs = opts?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId =
    ctrl && typeof window !== "undefined" && timeoutMs != null && Number.isFinite(timeoutMs)
      ? window.setTimeout(() => ctrl.abort(), timeoutMs)
      : null;
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      // Network dropped, timeout fired, or page is unloading. Either
      // way the save did not reach the server with a reply we could
      // read.
      return { ok: false, status: 0, data: null, kind: "no-reply" };
    }
    let data: unknown = null;
    let rawText: string | undefined;
    try {
      rawText = await res.text();
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          // keep rawText, data stays null
        }
      }
    } catch {
      // ignore - rawText / data stay undefined / null
    }
    if (res.ok) return { ok: true, status: res.status, data, kind: "ok" };
    if (res.status >= 500) return { ok: false, status: res.status, data, kind: "server", rawText };
    return { ok: false, status: res.status, data, kind: "refused", rawText };
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId);
  }
}

export function errMsg(data: unknown, fallback: string): string {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    typeof (data as { error?: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return fallback;
}

// The one place the three sentences live. The hook calls this; so does
// any caller that wants the sentence without the hook's extra state.
// Status numbers and code names never ride onto the page from here.
export function saveErrorSentence(r: SaveOutcome): string | null {
  if (r.ok) return null;
  if (r.kind === "no-reply") {
    return "Could not reach the server. Nothing was saved.";
  }
  if (r.kind === "server") {
    if (r.rawText && typeof console !== "undefined") {
      try {
        console.error("Server save failure:", r.rawText);
      } catch {
        /* noop */
      }
    }
    return "The server could not save this. Nothing was saved.";
  }
  const explicit = errMsg(r.data, "");
  if (explicit) {
    const trimmed = explicit.trim().replace(/[.!?]+$/, "");
    return `${trimmed}. Nothing was saved.`;
  }
  return "The server refused this. Nothing was saved.";
}
