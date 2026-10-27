"use client";

// One-click runner for /api/admin/pack-override-migrate. Converts the
// pre-Phase-1.8 free-text pack_override rows to the structured shape
// via parsePack + estimateFromOverride. Reports converted vs flagged
// counts + a short sample list. Idempotent.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Check, AlertTriangle } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

type Sample = { id: string; result: "converted" | "flagged"; from: string; to?: string };
type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; converted: number; flagged: number; skipped: number; samples: Sample[] }
  | { kind: "error"; message: string };

export function PackOverrideMigrateButton() {
  const router = useRouter();
  const [state, setState] = useState<RunState>({ kind: "idle" });

  async function run() {
    if (state.kind === "running") return;
    setState({ kind: "running" });
    type Resp = {
      ok?: boolean;
      error?: string;
      converted?: number;
      flagged?: number;
      skipped?: number;
      samples?: Sample[];
    };
    let data: Resp | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/admin/pack-override-migrate", { method: "POST" });
      status = res.status;
      data = (await res.json().catch(() => null)) as Resp | null;
      if (!res.ok || !data?.ok) {
        const msg = data?.error ?? `Migration failed (${status})`;
        toast(msg, { tone: "block" });
        setState({ kind: "error", message: msg });
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg, { tone: "block" });
      setState({ kind: "error", message: msg });
      return;
    }
    const converted = data.converted ?? 0;
    const flagged = data.flagged ?? 0;
    const skipped = data.skipped ?? 0;
    toast(
      `Migration done: ${fmtCount(converted)} converted, ${fmtCount(flagged)} flagged, ${fmtCount(skipped)} already structured`
    );
    setState({ kind: "done", converted, flagged, skipped, samples: data.samples ?? [] });
    router.refresh();
  }

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
            <span>Migrate text overrides</span>
          </>
        ) : state.kind === "running" ? (
          <span>Running...</span>
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

      {state.kind === "done" ? (
        <>
          <ul className="kf-admin-run__counts" aria-live="polite">
            <li>
              <span className="kf-admin-run__k">Converted</span>
              <strong>{fmtCount(state.converted)}</strong>
              <span className="kf-admin-run__sub">
                parsed cleanly, structured + per-unit recomputed
              </span>
            </li>
            <li>
              <span className="kf-admin-run__k">Needs re-entry</span>
              <strong>{fmtCount(state.flagged)}</strong>
              <span className="kf-admin-run__sub">
                parse=none; flipped to pack_state=&apos;override&apos; with a re-enter note
              </span>
            </li>
            <li>
              <span className="kf-admin-run__k">Skipped</span>
              <strong>{fmtCount(state.skipped)}</strong>
              <span className="kf-admin-run__sub">
                already structured (idempotent re-run)
              </span>
            </li>
          </ul>
          {state.samples.length > 0 ? (
            <details className="kf-admin-run__samples">
              <summary>Sample ({state.samples.length})</summary>
              <ul>
                {state.samples.map((s) => (
                  <li key={s.id}>
                    <code>{s.id.slice(0, 8)}</code>{" "}
                    <span className={`kf-admin-run__k kf-admin-run__k--${s.result}`}>
                      {s.result}
                    </span>{" "}
                    <span className="kf-muted">from</span> <code>{s.from}</code>
                    {s.to ? (
                      <>
                        {" "}
                        <span className="kf-muted">to</span> <code>{s.to}</code>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {state.kind === "error" ? (
        <p className="kf-admin-run__err" role="alert">{state.message}</p>
      ) : null}
    </div>
  );
}
