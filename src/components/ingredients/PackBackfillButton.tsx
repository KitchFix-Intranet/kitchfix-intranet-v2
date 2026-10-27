"use client";

// One-click runner for /api/admin/pack-backfill. The route is
// cursor-batched (BATCH=400 per call); this component loops until
// `done=true`, accumulates the counts, and shows progress + the final
// summary. Button stays idempotent per the spec; re-running after a
// finished pass just confirms zero new writes.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Check, AlertTriangle } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

type Counts = { ok: number; check: number; none: number; skipped: number };

type RunState =
  | { kind: "idle" }
  | { kind: "running"; processed: number; counts: Counts }
  | { kind: "done"; processed: number; counts: Counts }
  | { kind: "error"; message: string; processed: number; counts: Counts };

const ZERO: Counts = { ok: 0, check: 0, none: 0, skipped: 0 };

export function PackBackfillButton() {
  const router = useRouter();
  const [state, setState] = useState<RunState>({ kind: "idle" });

  async function run() {
    if (state.kind === "running") return;
    setState({ kind: "running", processed: 0, counts: { ...ZERO } });
    let offset = 0;
    let total = 0;
    const sum: Counts = { ...ZERO };
    type Resp = {
      ok?: boolean;
      done?: boolean;
      processed?: number;
      nextOffset?: number;
      counts?: Counts;
      error?: string;
    };
    for (let safety = 0; safety < 1000; safety += 1) {
      let data: Resp | null = null;
      let status = 0;
      try {
        const res = await fetch("/api/admin/pack-backfill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset }),
        });
        status = res.status;
        data = (await res.json().catch(() => null)) as Resp | null;
        if (!res.ok || !data?.ok) {
          const msg = data?.error ?? `Backfill failed (${status})`;
          toast(msg, { tone: "block" });
          setState({ kind: "error", message: msg, processed: total, counts: sum });
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast(msg, { tone: "block" });
        setState({ kind: "error", message: msg, processed: total, counts: sum });
        return;
      }
      const processed = data?.processed ?? 0;
      total += processed;
      const c = data?.counts ?? ZERO;
      sum.ok += c.ok;
      sum.check += c.check;
      sum.none += c.none;
      sum.skipped += c.skipped;
      setState({ kind: "running", processed: total, counts: { ...sum } });
      if (data?.done) break;
      offset = data?.nextOffset ?? offset + processed;
      if (processed === 0) break; // defensive against an infinite loop
    }
    toast(`Pack backfill done: ${fmtCount(total)} rows processed`);
    setState({ kind: "done", processed: total, counts: sum });
    router.refresh();
  }

  const counts =
    state.kind === "running" || state.kind === "done" || state.kind === "error" ? state.counts : ZERO;
  const processed =
    state.kind === "running" || state.kind === "done" || state.kind === "error" ? state.processed : 0;

  return (
    <div className="kf-admin-run">
      <button
        type="button"
        className={`kf-btn kf-btn--primary${state.kind === "running" ? " is-busy" : ""}`}
        disabled={state.kind === "running"}
        onClick={run}
      >
        {state.kind === "idle" ? (
          <>
            <Play size={16} strokeWidth={1.5} />
            <span>Run pack backfill</span>
          </>
        ) : state.kind === "running" ? (
          <span>Running... {fmtCount(processed)} processed</span>
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

      {state.kind !== "idle" ? (
        <ul className="kf-admin-run__counts" aria-live="polite">
          <li>
            <span className="kf-admin-run__k">High</span>
            <strong>{fmtCount(counts.ok)}</strong>
            <span className="kf-admin-run__sub">
              pack parsed and per-unit emitted (pack_state=&apos;ok&apos;)
            </span>
          </li>
          <li>
            <span className="kf-admin-run__k">Low</span>
            <strong>{fmtCount(counts.check)}</strong>
            <span className="kf-admin-run__sub">
              parsed but low-confidence (ranges / average / soft; pack_state=&apos;check&apos;)
            </span>
          </li>
          <li>
            <span className="kf-admin-run__k">Unparsed</span>
            <strong>{fmtCount(counts.none)}</strong>
            <span className="kf-admin-run__sub">
              could not parse pack text; needs human (pack_state=&apos;none&apos;)
            </span>
          </li>
          <li>
            <span className="kf-admin-run__k">Skipped</span>
            <strong>{fmtCount(counts.skipped)}</strong>
            <span className="kf-admin-run__sub">
              pack_override present (human-attested) - left untouched
            </span>
          </li>
        </ul>
      ) : null}

      {state.kind === "error" ? (
        <p className="kf-admin-run__err" role="alert">{state.message}</p>
      ) : null}
    </div>
  );
}
