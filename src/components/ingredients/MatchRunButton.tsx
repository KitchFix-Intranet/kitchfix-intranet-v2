"use client";

// One-click runner for POST /api/match. The matcher reads unlinked food
// vendor items dollar-ordered and writes link_status='proposed' - it
// does not confirm anything, so this button is safe to re-run.
//
// The endpoint is a single long-running request (not cursor-batched
// like /api/admin/pack-backfill). maxDuration = 300 server-side; the
// browser fetch has no client timeout, so a wave of a few hundred
// items can take minutes without the UI aborting early.
//
// Mirrors PackBackfillButton's shape: idle -> running -> done/error,
// counts panel + optional error paragraph. Adds an optional "limit"
// numeric input so Kevin controls the wave size (blank = all).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Check, AlertTriangle } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

type MatchCounts = {
  items_read?: number;
  items_sent?: number;
  decisions_received?: number;
  invalid_ids_dropped?: number;
  proposed_existing?: number;
  proposed_new?: number;
  marked_not_food?: number;
  write_errors?: number;
  batches_ok?: number;
  batches_failed?: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
};

type MatchResp = {
  status?: "ok" | "failed";
  counts?: MatchCounts;
  note?: string | null;
  runId?: string | null;
};

type RunState =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "done"; counts: MatchCounts; note: string | null; limit: number | null; elapsedMs: number }
  | { kind: "error"; message: string; counts: MatchCounts | null; note: string | null; elapsedMs: number };

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

export function MatchRunButton() {
  const router = useRouter();
  const [limitStr, setLimitStr] = useState<string>("");
  const [state, setState] = useState<RunState>({ kind: "idle" });

  async function run() {
    if (state.kind === "running") return;
    const trimmed = limitStr.trim();
    let limit: number | null = null;
    if (trimmed.length > 0) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        toast("Limit must be a positive integer (blank = all).", { tone: "block" });
        return;
      }
      limit = n;
    }

    const startedAt = Date.now();
    setState({ kind: "running", startedAt });

    const qs = limit != null ? `?limit=${limit}` : "";
    let data: MatchResp | null = null;
    let status = 0;
    try {
      // No AbortController + no timeout. The server maxDuration is 300s;
      // the browser fetch will wait as long as the server holds the
      // connection, which is what we want for a multi-minute matcher
      // wave.
      const res = await fetch(`/api/match${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as MatchResp | null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg, { tone: "block" });
      setState({
        kind: "error",
        message: msg,
        counts: null,
        note: null,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    const counts = data?.counts ?? null;
    const note = data?.note ?? null;

    if (status < 200 || status >= 300 || data?.status === "failed") {
      const msg = note ?? `Matcher failed (${status})`;
      toast(msg, { tone: "block" });
      setState({ kind: "error", message: msg, counts, note, elapsedMs });
      return;
    }

    const proposedTotal = (counts?.proposed_existing ?? 0) + (counts?.proposed_new ?? 0);
    toast(
      `Matcher done: ${fmtCount(proposedTotal)} new proposal${proposedTotal === 1 ? "" : "s"} in ${fmtElapsed(elapsedMs)}`
    );
    setState({ kind: "done", counts: counts ?? {}, note, limit, elapsedMs });
    router.refresh();
  }

  const running = state.kind === "running";

  return (
    <div className="kf-admin-run">
      <div className="kf-admin-run__inputs">
        <label className="kf-dpn__label kf-admin-run__limit">
          <span>Limit (blank = all)</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            placeholder="e.g. 500 for a first wave"
            value={limitStr}
            onChange={(e) => setLimitStr(e.target.value)}
            disabled={running}
          />
        </label>

        <button
          type="button"
          className={`kf-btn kf-btn--primary${running ? " is-busy" : ""}`}
          disabled={running}
          onClick={run}
        >
          {state.kind === "idle" ? (
            <>
              <Play size={16} strokeWidth={1.5} />
              <span>Run matcher</span>
            </>
          ) : state.kind === "running" ? (
            <span>Running... this can take a few minutes</span>
          ) : state.kind === "done" ? (
            <>
              <Check size={16} strokeWidth={2} />
              <span>Re-run</span>
            </>
          ) : (
            <>
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>Try again</span>
            </>
          )}
        </button>
      </div>

      {state.kind === "done" || state.kind === "error" ? (
        <RunSummary
          counts={state.kind === "done" ? state.counts : state.counts ?? {}}
          note={state.kind === "done" ? state.note : state.note}
          elapsedMs={state.elapsedMs}
          limit={state.kind === "done" ? state.limit : null}
        />
      ) : null}

      {state.kind === "error" ? (
        <p className="kf-admin-run__err" role="alert">{state.message}</p>
      ) : null}
    </div>
  );
}

function RunSummary({
  counts,
  note,
  elapsedMs,
  limit,
}: {
  counts: MatchCounts;
  note: string | null;
  elapsedMs: number;
  limit: number | null;
}) {
  const proposedExisting = counts.proposed_existing ?? 0;
  const proposedNew = counts.proposed_new ?? 0;
  const markedNotFood = counts.marked_not_food ?? 0;
  const batchesOk = counts.batches_ok ?? 0;
  const batchesFailed = counts.batches_failed ?? 0;
  const itemsRead = counts.items_read ?? 0;
  const writeErrors = counts.write_errors ?? 0;

  return (
    <>
      <ul className="kf-admin-run__counts" aria-live="polite">
        <li>
          <span className="kf-admin-run__k">Proposed (existing)</span>
          <strong>{fmtCount(proposedExisting)}</strong>
          <span className="kf-admin-run__sub">
            items routed to an existing ingredient (<code>link_status=&apos;proposed&apos;</code>)
          </span>
        </li>
        <li>
          <span className="kf-admin-run__k">Proposed (new)</span>
          <strong>{fmtCount(proposedNew)}</strong>
          <span className="kf-admin-run__sub">
            items with an <code>ai-new:</code> proposed-name payload for review
          </span>
        </li>
        <li>
          <span className="kf-admin-run__k">Marked not food</span>
          <strong>{fmtCount(markedNotFood)}</strong>
          <span className="kf-admin-run__sub">
            model called it not food; the queue shows these as a small counter
          </span>
        </li>
        <li>
          <span className="kf-admin-run__k">Batches</span>
          <strong>
            {fmtCount(batchesOk)}
            {batchesFailed > 0 ? <> / {fmtCount(batchesFailed)} failed</> : null}
          </strong>
          <span className="kf-admin-run__sub">
            processed {fmtCount(itemsRead)} items in {fmtElapsed(elapsedMs)}
            {limit != null ? <> · limit {fmtCount(limit)}</> : null}
            {writeErrors > 0 ? <> · <strong>{fmtCount(writeErrors)} write errors</strong></> : null}
          </span>
        </li>
      </ul>
      {note ? (
        <p className="kf-admin-run__note">
          <span className="kf-admin-run__k">Note</span>
          <span>{note}</span>
        </p>
      ) : null}
    </>
  );
}
