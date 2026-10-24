"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RunIntakeButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();

  const run = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const res = await fetch("/api/intake?mode=full", { method: "POST" });
      if (res.status === 401) throw new Error("You are signed out. Reload and try again.");
      if (res.status === 404) throw new Error("Not permitted.");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.note ?? `Intake failed (${res.status})`);
      setNote(`Intake ok - ${JSON.stringify(body.counts)}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="kf-btn kf-btn--line kf-btn--sm" onClick={run} disabled={busy}>
        <RefreshCw size={14} strokeWidth={1.5} />
        <span>{busy ? "Running..." : "Run intake"}</span>
      </button>
      {err ? <p className="kf-ing__status-err" role="alert">{err}</p> : null}
      {note ? <p className="kf-ing__status-ok">{note}</p> : null}
    </>
  );
}
