"use client";

// T4 §4: Show more past the first 25 events. Fetches 25 at a time
// through /api/review/ledger?before=<iso>, appending them to the list.
// Server-rendered first page lives in <ReviewLedger />.

import { useState } from "react";
import { timeAgo, fmtDate } from "@/lib/fmt";

type LedgerRowDto = {
  id: string;
  kind: string;
  at: string;
  actor_name: string;
  // Rendered fields come from the server, not the client - keep this
  // DTO small and let the client join it to a ReactNode.
  label: string;
  text: string;
  undoable: { kind: "none"; reason: string } | { kind: "snapshot"; eventId: string } | { kind: "legacy_confirm"; itemIds: string[] } | { kind: "merge"; sourceId: string };
};

export function ShowMoreLedger({
  pageSize,
  oldestAt,
}: {
  pageSize: number;
  oldestAt: string;
}) {
  const [rows, setRows] = useState<LedgerRowDto[]>([]);
  const [cursor, setCursor] = useState<string>(oldestAt);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      const u = new URL("/api/review/ledger", window.location.origin);
      u.searchParams.set("before", cursor);
      u.searchParams.set("limit", String(pageSize));
      const res = await fetch(u.toString(), { cache: "no-store" });
      if (!res.ok) throw new Error("Could not reach the server.");
      const data = (await res.json()) as { rows: LedgerRowDto[] };
      if (!data.rows || data.rows.length === 0) {
        setDone(true);
      } else {
        setRows((prev) => [...prev, ...data.rows]);
        setCursor(data.rows[data.rows.length - 1].at);
        if (data.rows.length < pageSize) setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more decisions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kf-review__ledger-more">
      {rows.length > 0 ? (
        <ul className="kf-review__ledger-list">
          {rows.map((r) => (
            <li key={r.id}>
              <article className="kf-review__ledger-row kf-review__ledger-row--muted">
                <div className="kf-review__ledger-primary">
                  <span className="kf-review__ledger-kind">{r.label}</span>
                  <span className="kf-review__ledger-text">{r.text}</span>
                </div>
                <div className="kf-review__ledger-meta">
                  <span className="kf-review__ledger-when">
                    <time dateTime={r.at} title={fmtDate(r.at, "time")}>{timeAgo(r.at)}</time>
                  </span>
                  <span className="kf-review__ledger-actor">{r.actor_name}</span>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="kf-review__ledger-empty" role="alert">{error}</p>
      ) : null}
      {!done ? (
        <button
          type="button"
          className={`kf-btn kf-btn--line kf-btn--sm${busy ? " is-busy" : ""}`}
          onClick={more}
          disabled={busy}
        >
          {busy ? "Loading..." : "Show more"}
        </button>
      ) : rows.length > 0 ? (
        <p className="kf-review__ledger-empty">No older decisions.</p>
      ) : null}
    </div>
  );
}
