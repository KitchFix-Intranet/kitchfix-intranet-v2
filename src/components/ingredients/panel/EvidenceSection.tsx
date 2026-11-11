"use client";

// Evidence - lazy-loaded on first expand. Fetches /api/review/item-evidence.
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Info } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd } from "@/lib/fmt";
import type { ReviewGroupItem } from "../itemTypes";
import { fmtUsdCents } from "./packHelpers";

// EvidenceBody renders its own tone icons; AttentionIcon mirrors the
// one in ./attention so no extra import crosses modules.
function AttentionIcon({ tone }: { tone: "bad" | "warn" | "info" | "good" }) {
  if (tone === "good") return <Check size={16} strokeWidth={1.75} aria-hidden />;
  if (tone === "info") return <Info size={16} strokeWidth={1.75} aria-hidden />;
  return <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />;
}

type EvidenceInvoiceLine = {
  date: string | null;
  site: string;
  qty: number | null;
  unitPrice: number | null;
  extended: number | null;
  billedUnit: string | null;
  weightLineValue: number | null;
};
type EvidenceBySite = {
  site: string;
  lines: number;
  spend: number;
  lastPaid: number | null;
  lastBuy: string | null;
};
type EvidenceSibling = {
  id: string;
  name: string;
  vendor: string;
  pack: string | null;
  perBase: number | null;
  perBaseUom: string | null;
  usd12m: number;
};
type EvidenceVariant = { name: string; count: number };
type EvidencePayload = {
  catchWeight: boolean;
  invoiceLines: EvidenceInvoiceLine[];
  bySite: EvidenceBySite[];
  siblings: EvidenceSibling[];
  variants: EvidenceVariant[];
};

export function EvidenceSection({ item }: { item: ReviewGroupItem }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ready"; data: EvidencePayload }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  // Which item id's fetch has been kicked off. The effect cannot read
  // `state.phase` as a dep: it mutates state.phase to "loading", which
  // retriggers itself, cancels the in-flight request, and the whole
  // thing stays stuck on "Loading..." - verified live on step-1 before
  // this fix. Keep deps narrow and track "already requested" out of
  // band in a ref. Item change (new id) naturally refetches because
  // requestedFor stays on the OLD id until the new effect runs.
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open || requestedFor.current === item.id) return;
    requestedFor.current = item.id;
    let cancelled = false;
    // Only keep the ref set when the request actually succeeded.
    // Three stall cases the first ref-only fix left:
    //   1. collapsed mid-flight -> cleanup fires cancelled=true,
    //      fetch short-circuits, ref stays pointing at this id,
    //      reopen is cached-not-done forever.
    //   2. fetch returned !ok -> error state renders, ref stays,
    //      no retry on reopen.
    //   3. fetch threw -> same as 2.
    // Track completion with `done`; cleanup clears the ref when it
    // was abandoned, and the error branches clear it inline so a
    // reopen refetches rather than showing a permanent error.
    let done = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/review/item-evidence?id=${encodeURIComponent(item.id)}`);
        const data = (await res.json().catch(() => null)) as EvidencePayload | { error?: string } | null;
        if (cancelled) return;
        if (!res.ok || !data || "error" in data) {
          const msg =
            data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `Fetch failed (${res.status})`;
          requestedFor.current = null;
          setState({ phase: "error", message: msg });
          done = true;
          return;
        }
        setState({ phase: "ready", data: data as EvidencePayload });
        done = true;
      } catch (e) {
        if (cancelled) return;
        requestedFor.current = null;
        setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        done = true;
      }
    })();
    return () => {
      cancelled = true;
      // Abandoned mid-flight: let the next open refetch.
      if (!done) requestedFor.current = null;
    };
  }, [open, item.id]);

  const summary =
    state.phase === "ready"
      ? `${fmtCount(state.data.invoiceLines.length)} line${state.data.invoiceLines.length === 1 ? "" : "s"} · ${fmtCount(state.data.bySite.length)} site${state.data.bySite.length === 1 ? "" : "s"}`
      : "";

  return (
    <section className="kf-drawer__block kf-dpn__block" aria-label="Evidence">
      <button
        type="button"
        className="kf-attn__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={`kf-attn__chev${open ? " is-open" : ""}`}
        />
        <h4 className="kf-attn__title">Evidence</h4>
        <span className="kf-attn__count">{summary || "expand to load"}</span>
      </button>
      {open ? (
        <div className="kf-evidence">
          {state.phase === "loading" ? (
            <div className="kf-muted">Loading...</div>
          ) : state.phase === "error" ? (
            <div className="kf-attn__note kf-attn__note--bad">
              <AttentionIcon tone="bad" />
              <div>
                <b>Could not load evidence</b>
                <span>{state.message}</span>
              </div>
            </div>
          ) : state.phase === "ready" ? (
            <EvidenceBody data={state.data} highlightItemId={item.id} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EvidenceBody({
  data,
  highlightItemId,
}: {
  data: EvidencePayload;
  highlightItemId: string;
}) {
  return (
    <>
      {data.invoiceLines.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Invoice lines</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Site</th>
                  <th className="kf-evi__num">{data.catchWeight ? "Billed weight" : "Qty"}</th>
                  <th className="kf-evi__num">{data.catchWeight ? "$ / lb" : "Unit $"}</th>
                  <th className="kf-evi__num">Extended</th>
                </tr>
              </thead>
              <tbody>
                {data.invoiceLines.map((l, i) => (
                  <tr key={i}>
                    <td>{fmtDate(l.date, "short")}</td>
                    <td>{l.site}</td>
                    <td className="kf-evi__num">
                      {data.catchWeight
                        ? l.weightLineValue != null
                          ? `${l.weightLineValue.toFixed(2)} lb`
                          : "-"
                        : l.qty != null
                          ? fmtCount(l.qty)
                          : "-"}
                    </td>
                    <td className="kf-evi__num">
                      {l.unitPrice != null ? fmtUsdCents(l.unitPrice) : "-"}
                    </td>
                    <td className="kf-evi__num">
                      {l.extended != null ? fmtUsdCents(l.extended) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.bySite.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Spend by site</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Site</th>
                  <th className="kf-evi__num">Lines</th>
                  <th className="kf-evi__num">Spend</th>
                  <th className="kf-evi__num">Last paid</th>
                  <th>Last buy</th>
                </tr>
              </thead>
              <tbody>
                {data.bySite.map((s) => (
                  <tr key={s.site}>
                    <td>{s.site}</td>
                    <td className="kf-evi__num">{fmtCount(s.lines)}</td>
                    <td className="kf-evi__num">{fmtUsd(s.spend)}</td>
                    <td className="kf-evi__num">{s.lastPaid != null ? fmtUsd(s.lastPaid) : "-"}</td>
                    <td>{fmtDate(s.lastBuy, "short")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.siblings.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Other items on this ingredient</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Pack</th>
                  <th className="kf-evi__num">Per-unit</th>
                  <th className="kf-evi__num">Annual $</th>
                </tr>
              </thead>
              <tbody>
                {data.siblings.map((s) => (
                  <tr key={s.id} className={s.id === highlightItemId ? "kf-evi__row--self" : undefined}>
                    <td title={s.name}>
                      <div className="kf-cell-strong kf-cell-ellipsis">{s.vendor}</div>
                      <div className="kf-cell-sub kf-cell-ellipsis">{s.name}</div>
                    </td>
                    <td>{s.pack ?? "-"}</td>
                    <td className="kf-evi__num">
                      {s.perBase != null ? (
                        <>
                          <strong>{fmtUsd(s.perBase)}</strong>
                          <span className="kf-muted">
                            {" "}
                            / {s.perBaseUom === "LB" ? "lb" : s.perBaseUom === "FLOZ" ? "fl oz" : s.perBaseUom === "EA" ? "each" : s.perBaseUom ?? "unit"}
                          </span>
                        </>
                      ) : (
                        <span className="kf-muted">-</span>
                      )}
                    </td>
                    <td className="kf-evi__num">{fmtUsd(s.usd12m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data.variants.length > 0 ? (
        <div className="kf-evi__group">
          <h5 className="kf-evi__h">Description variants</h5>
          <div className="kf-evi__scroll">
            <table className="kf-evi__t">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="kf-evi__num">Lines (12m)</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((v) => (
                  <tr key={v.name}>
                    <td>{v.name}</td>
                    <td className="kf-evi__num">{fmtCount(v.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Composite that wires Attention + Pack + Price + Evidence together,
// holding the shared pack-hint state the Attention "Fix the pack"
// button writes into and the Pack chain reads.
