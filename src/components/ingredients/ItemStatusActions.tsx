"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = { id: string; status: string };

export function ItemStatusActions({ id, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [undoFrom, setUndoFrom] = useState<string | null>(null);

  async function setStatus(to: string, label: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/vendor-items/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Status ${res.status}`);
      }
      setUndoFrom(status);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!undoFrom) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/vendor-items/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: undoFrom }),
      });
      if (!res.ok) throw new Error(await res.text());
      setUndoFrom(null);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kf-actions">
      <button className="kf-btn kf-btn--line kf-btn--sm" disabled={busy || status === "archived"} onClick={() => setStatus("archived", "Archive")}>
        Archive
      </button>
      <button className="kf-btn kf-btn--line kf-btn--sm" disabled={busy || status === "one_off"} onClick={() => setStatus("one_off", "One-off")}>
        One-off
      </button>
      {undoFrom ? (
        <button className="kf-btn kf-btn--filled kf-btn--sm" onClick={undo} disabled={busy}>
          Undo
        </button>
      ) : null}
      {err ? <span className="kf-ing__status-err">{err}</span> : null}
    </div>
  );
}
