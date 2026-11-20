"use client";

// T5b item 4: the batch control on the Review queue's empty state (and
// train 9 will reuse it on Overview). Three sizes, 50 / 100 / 200;
// default 100 (ruling 6). Pressing it is a deliberate, paid act:
// one press starts one run, a second press while a run is in progress
// cannot start a second run from this tab or another (ruling 7). The
// server guard lives in /api/review/batch-start.
//
// Long-job path (ruling 8): the browser fetch has no 30 s cap and
// holds the connection for the full run. If the connection ends
// without an answer we say so plainly and router.refresh() picks up
// whatever came in. A failed run shows the server's reason + the
// same "Some items may have come in." tail when any were written.
//
// We never start a run here from a test. The /api/match route is
// untouched; this control posts to the sibling /api/review/batch-start
// which calls runMatcher from the lib directly.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import { postJson, saveErrorSentence } from "./panel/common";

// T5b ruling 6: stated once. The route carries the same list; the two
// cannot drift silently because any other value is refused on both
// ends.
const SIZES = [50, 100, 200] as const;
type Size = (typeof SIZES)[number];
const DEFAULT_SIZE: Size = 100;

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
  status?: "ok" | "failed";
  counts?: RunCounts;
  note?: string | null;
  reason?: string;
};

type Mode =
  | { kind: "idle" }
  | { kind: "running"; size: Size; startedAt: number }
  | { kind: "done"; sentence: string }
  | { kind: "fail"; sentence: string };

export function BatchRunControl({
  unlinkedCount,
  inProgress,
  layout = "stacked",
}: {
  unlinkedCount: number;
  inProgress: boolean;
  // "stacked" is the Review queue's empty state (size menu + button
  // on their own row). "inline" is train 9's Overview card where the
  // control sits alongside other text. Same primitives.
  layout?: "stacked" | "inline";
}) {
  const router = useRouter();
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [mode, setMode] = useState<Mode>(
    inProgress ? { kind: "running", size: DEFAULT_SIZE, startedAt: Date.now() } : { kind: "idle" },
  );

  const busy = mode.kind === "running" || inProgress;

  async function run() {
    if (busy) return;
    const startedAt = Date.now();
    setMode({ kind: "running", size, startedAt });
    // T2 §1 long-job rule: no timeoutMs. The matcher wave can run
    // the full 300 s cap. postJson returns a shape - it never throws
    // on no-reply - so the ruling-8 branch reads r.kind.
    const r = await postJson(
      "/api/review/batch-start",
      { size },
      { timeoutMs: null },
    );
    if (r.kind === "no-reply") {
      // The connection ended without an answer (closed tab, 504 past
      // the cap, network cut). Per ruling 8 we say so and refresh
      // so whatever landed shows.
      setMode({
        kind: "fail",
        sentence: "The batch did not finish. Some items may have come in.",
      });
      router.refresh();
      return;
    }
    const data = (r.data ?? null) as BatchResp | null;
    if (r.status === 409) {
      // The server refused because another tab started one first.
      setMode({
        kind: "fail",
        sentence: data?.reason ?? "A batch is already running. Nothing new was started.",
      });
      router.refresh();
      return;
    }
    if (!r.ok || data?.status === "failed") {
      const counts = data?.counts ?? {};
      const landed = (counts.proposed_existing ?? 0) + (counts.proposed_new ?? 0) + (counts.marked_not_food ?? 0);
      const serverReason = saveErrorSentence(r) ?? data?.note ?? "Nothing was saved.";
      const tail = landed > 0 ? " Some items may have come in." : "";
      setMode({ kind: "fail", sentence: `${serverReason}${tail}` });
      router.refresh();
      return;
    }

    const counts = data?.counts ?? {};
    const groupsCameIn = (counts.proposed_existing ?? 0) + (counts.proposed_new ?? 0);
    const setAside = counts.marked_not_food ?? 0;
    const sentence =
      groupsCameIn === 0 && setAside === 0
        ? "Nothing new came in."
        : `${fmtCount(groupsCameIn)} ${groupsCameIn === 1 ? "group" : "groups"} came in; ${fmtCount(setAside)} set aside as not food.`;
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
  if (inProgress) {
    return (
      <span className="kf-msg kf-msg--why" role="status">
        A batch is already running. Nothing new was started.
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
