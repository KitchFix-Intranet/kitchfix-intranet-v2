"use client";

// T5b item 4 + round 2 item 3: the batch control on the Review
// queue's empty state (train 9 will reuse it on Overview). Three
// sizes - 50 / 100 / 200, default 100. Pressing it is a paid act:
// one press starts one run, a second press while a run is live
// cannot start a second run from this tab or another (see
// src/lib/matcher/claim.ts for the claim-and-check).
//
// Long-job path (ruling 8): the browser fetch has no 30 s cap and
// holds the connection for the full run. A connection that ends
// without an answer says so plainly and router.refresh() picks up
// whatever came in. A failed run with any writes shows "Some items
// may have come in." A tab that opens while a run is live says so,
// polls the loader every 30 s (and on tab focus) until the run is
// over, then offers the control. The poll never starts a run.
//
// We never start a run from a test. The /api/match route is
// untouched; this control posts to /api/review/batch-start which
// calls runMatcher from the lib directly.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import { postJson, saveErrorSentence } from "./panel/common";

// T5b ruling 6: stated once, mirrored in the route. Any other
// value is refused on both ends.
const SIZES = [50, 100, 200] as const;
type Size = (typeof SIZES)[number];
const DEFAULT_SIZE: Size = 100;

// Poll cadence while a run is live. 30 s costs one cheap read per
// cycle (loadReview's four short selects) and refreshes the whole
// page via router.refresh when the run ends.
const LIVE_POLL_MS = 30_000;

type RunCounts = {
  items_read?: number;
  items_sent?: number;
  decisions_received?: number;
  proposed_existing?: number;
  proposed_new?: number;
  marked_not_food?: number;
  write_errors?: number;
};

type BatchResp = {
  status?: "ok" | "failed" | "in_progress" | "rejected";
  counts?: RunCounts;
  reason?: string;
};

type Mode =
  | { kind: "idle" }
  | { kind: "running"; size: Size; startedAt: number }
  | { kind: "liveFromOtherTab" }
  | { kind: "done"; sentence: string }
  | { kind: "fail"; sentence: string };

export function BatchRunControl({
  unlinkedCount,
  inProgress,
  layout = "stacked",
}: {
  unlinkedCount: number;
  inProgress: boolean;
  // "stacked" is the empty queue's one-line control. "inline" is
  // train 9's Overview card, where the control sits alongside the
  // card's text. Same primitives, one CSS modifier.
  layout?: "stacked" | "inline";
}) {
  const router = useRouter();
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [mode, setMode] = useState<Mode>(
    inProgress ? { kind: "liveFromOtherTab" } : { kind: "idle" },
  );
  const pollTimerRef = useRef<number | null>(null);

  // T5b round 2 item 3: a tab that opens (or renders a navigation
  // update) while a run is live shows "A batch is running." The
  // polling tick re-renders the page; when loadReview's four selects
  // say the run is over, inProgress flips to false and the control
  // comes back. Switching away then back triggers the visibility
  // handler so the user does not wait a full 30 s after returning.
  const checkNow = useCallback(() => {
    router.refresh();
  }, [router]);

  useEffect(() => {
    // Keep internal mode in step with the server-supplied flag on
    // re-render: if the server now says "not in progress", drop the
    // "liveFromOtherTab" state back to idle.
    if (inProgress && mode.kind === "idle") {
      setMode({ kind: "liveFromOtherTab" });
      return;
    }
    if (!inProgress && mode.kind === "liveFromOtherTab") {
      setMode({ kind: "idle" });
    }
  }, [inProgress, mode.kind]);

  useEffect(() => {
    if (mode.kind !== "liveFromOtherTab") {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    // Poll by asking Next to refresh the current route: the Review
    // queue's server components (and the @topbar slot) re-run their
    // loader, which reads pr_events and returns a fresh
    // batchInProgress. No new endpoint; no matcher call.
    pollTimerRef.current = window.setInterval(checkNow, LIVE_POLL_MS);
    const onVis = () => {
      if (!document.hidden) checkNow();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mode.kind, checkNow]);

  const busy = mode.kind === "running" || mode.kind === "liveFromOtherTab";

  async function run() {
    if (busy) return;
    const startedAt = Date.now();
    setMode({ kind: "running", size, startedAt });
    const r = await postJson(
      "/api/review/batch-start",
      { size },
      { timeoutMs: null },
    );
    if (r.kind === "no-reply") {
      // T5b round 2 item 3: the connection ended without an answer
      // (closed tab, 504 past the 300 s cap, network cut). The
      // ledger side is the source of truth; we refresh and say what
      // may have happened.
      setMode({
        kind: "fail",
        sentence: "The batch stopped before it finished. Some items may have come in.",
      });
      router.refresh();
      return;
    }
    const data = (r.data ?? null) as BatchResp | null;
    if (r.status === 409) {
      // Server refused: another tab started one first.
      setMode({ kind: "liveFromOtherTab" });
      router.refresh();
      return;
    }
    if (!r.ok || data?.status === "failed") {
      // Writes may still have landed. The server's `note` is raw
      // text that does not reach the page; we pick one of two
      // sentences based on whether any items came in.
      const counts = data?.counts ?? {};
      const landed =
        (counts.proposed_existing ?? 0) +
        (counts.proposed_new ?? 0) +
        (counts.marked_not_food ?? 0);
      const sentence =
        landed > 0
          ? "The batch stopped before it finished. Some items may have come in."
          : "The batch could not start. Nothing was brought in.";
      // Flip bonus state (dev tools): keep saveErrorSentence in the
      // console so a curator can still see why the server refused.
      saveErrorSentence(r);
      setMode({ kind: "fail", sentence });
      router.refresh();
      return;
    }

    const counts = data?.counts ?? {};
    const landed = (counts.proposed_existing ?? 0) + (counts.proposed_new ?? 0);
    const setAside = counts.marked_not_food ?? 0;
    const sentence =
      landed === 0 && setAside === 0
        ? "Nothing new came in."
        : `${fmtCount(landed)} ${landed === 1 ? "item" : "items"} came in for review. ${fmtCount(setAside)} set aside as not food.`;
    toast(sentence, { tone: "good" });
    setMode({ kind: "done", sentence });
    router.refresh();
  }

  if (unlinkedCount === 0) {
    return (
      <span className="kf-msg kf-msg--ok" role="status">
        Every food item has been matched.
      </span>
    );
  }

  if (mode.kind === "running") {
    return (
      <span className="kf-msg kf-msg--why" role="status">
        Starting a batch of {fmtCount(mode.size)}. You can keep working.
      </span>
    );
  }
  if (mode.kind === "liveFromOtherTab") {
    return (
      <span className="kf-msg kf-msg--why" role="status">
        A batch is running.
      </span>
    );
  }

  return (
    <div
      className={`kf-batch${layout === "inline" ? " kf-batch--inline" : ""}`}
      role="group"
      aria-label="Bring in a batch"
    >
      <label className="kf-labelled">
        Bring in
        <select
          className="kf-ctl"
          value={size}
          disabled={busy}
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            if ((SIZES as readonly number[]).includes(n)) {
              setSize(n as Size);
            }
          }}
          aria-label="How many items to bring in"
        >
          {SIZES.map((n) => (
            <option key={n} value={n}>
              the next {n}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
        disabled={busy}
        onClick={run}
      >
        {busy ? "Starting..." : "Bring in the next batch"}
      </button>
      {mode.kind === "done" ? (
        <span className="kf-msg kf-msg--ok" role="status">
          {mode.sentence}
        </span>
      ) : null}
      {mode.kind === "fail" ? (
        <span className="kf-msg kf-msg--fail" role="alert">
          {mode.sentence}
        </span>
      ) : null}
    </div>
  );
}
