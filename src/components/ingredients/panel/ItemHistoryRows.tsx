"use client";

// N13 §2c: two new closed rows for the item panel - Spend by site +
// Invoice wording. One lazy fetch to GET /api/vendor-items/[id]/history
// on first expand of either row; both rows read from the same cache so
// expanding one pre-warms the other. The row chrome reuses
// kf-ipanel__drow + kf-ipanel__drow-body from drawer.css; data tables
// use the new .kf-ipanel__history-table in vendor-items-tab.css.

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd } from "@/lib/fmt";

type Alias = { description: string; count: number; last_seen: string | null };
type Site = {
  account_key: string;
  lines: number;
  last_date: string | null;
  last_price: number | null;
  dollars: number;
};
type History = { aliases: Alias[]; sites: Site[] };

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; data: History }
  | { phase: "error"; message: string };

export function ItemHistoryRows({ itemId }: { itemId: string }) {
  const [sitesOpen, setSitesOpen] = useState(false);
  const [wordingOpen, setWordingOpen] = useState(false);
  const [state, setState] = useState<State>({ phase: "idle" });
  const requestedRef = useRef(false);

  // Fire the fetch once either row is expanded.
  useEffect(() => {
    if (!sitesOpen && !wordingOpen) return;
    if (requestedRef.current) return;
    requestedRef.current = true;
    setState({ phase: "loading" });
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/vendor-items/${encodeURIComponent(itemId)}/history`);
        const data = (await res.json().catch(() => null)) as History | { error?: string } | null;
        if (cancelled) return;
        if (!res.ok || !data || "error" in data) {
          const msg =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `Fetch failed (${res.status})`;
          setState({ phase: "error", message: msg });
          return;
        }
        setState({ phase: "ready", data: data as History });
      } catch (e) {
        if (cancelled) return;
        setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [sitesOpen, wordingOpen, itemId]);

  const data = state.phase === "ready" ? state.data : null;
  const siteCount = data?.sites.length ?? 0;
  const aliasCount = data?.aliases.length ?? 0;

  return (
    <>
      <Disclosure
        label="Spend by site"
        sub={state.phase === "ready" ? `${fmtCount(siteCount)} site${siteCount === 1 ? "" : "s"} · last 12 months` : "last 12 months"}
        open={sitesOpen}
        onToggle={() => setSitesOpen((v) => !v)}
      >
        <Body state={state} empty="No observations recorded yet.">
          {data && data.sites.length > 0 ? (
            <table className="kf-ipanel__history-table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th className="kf-vi__num">Lines</th>
                  <th className="kf-vi__num">Last paid</th>
                  <th>Last bought</th>
                </tr>
              </thead>
              <tbody>
                {data.sites.map((s) => (
                  <tr key={s.account_key}>
                    <td>{s.account_key}</td>
                    <td className="kf-vi__num">{fmtCount(s.lines)}</td>
                    <td className="kf-vi__num">
                      {s.last_price != null ? fmtUsd(s.last_price) : "-"}
                    </td>
                    <td>{s.last_date ? fmtDate(s.last_date) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Body>
      </Disclosure>
      <Disclosure
        label="Invoice wording"
        sub={
          state.phase === "ready"
            ? `${fmtCount(aliasCount)} way${aliasCount === 1 ? "" : "s"} this item has been written`
            : "every spelling the invoice has used"
        }
        open={wordingOpen}
        onToggle={() => setWordingOpen((v) => !v)}
      >
        <Body state={state} empty="No aliases recorded yet.">
          {data && data.aliases.length > 0 ? (
            <table className="kf-ipanel__history-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="kf-vi__num">Times</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.aliases.map((a) => (
                  <tr key={a.description}>
                    <td>{a.description}</td>
                    <td className="kf-vi__num">{fmtCount(a.count)}</td>
                    <td>{a.last_seen ? fmtDate(a.last_seen) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Body>
      </Disclosure>
    </>
  );
}

function Disclosure({
  label,
  sub,
  open,
  onToggle,
  children,
}: {
  label: string;
  sub: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="kf-ipanel__drow"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="kf-ipanel__drow-label">{label}</span>
        <span className="kf-ipanel__drow-sub">{sub}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          className={`kf-ipanel__drow-chev${open ? " is-open" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="kf-ipanel__drow-body">{children}</div> : null}
    </>
  );
}

function Body({
  state,
  empty,
  children,
}: {
  state: State;
  empty: string;
  children: React.ReactNode;
}) {
  if (state.phase === "loading") {
    return <p className="kf-ipanel__history-note">Loading…</p>;
  }
  if (state.phase === "error") {
    return <p className="kf-ipanel__history-note">Could not load: {state.message}</p>;
  }
  if (state.phase === "ready") {
    const hasData =
      ((state.data.aliases.length > 0 || state.data.sites.length > 0) && children);
    return hasData ? <>{children}</> : <p className="kf-ipanel__history-note">{empty}</p>;
  }
  return null;
}
