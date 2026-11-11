"use client";

// Per-item change ledger. Reads pr_events for THIS ingredient and
// vendor-item via a dedicated API endpoint (/api/review/item-events).
// Fetches on mount; shows last ~10 events newest-first with
// Chicago-friendly timestamps via fmtDate(.., "time") + a relative
// `timeAgo` sub-line. Each event kind gets a human-readable description
// pulled from `before`/`after` snapshots.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0 - markup, classes
// and fetch-on-mount semantics unchanged.

import React, { useEffect, useState } from "react";
import { fmtDate, timeAgo } from "@/lib/fmt";
import { humanizeKind } from "@/lib/humanizeKind";

export type LedgerEvent = {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export function LedgerBlock({
  ingredientId,
  itemId,
  // N7 §3f: history fetches on first open, not on mount. Caller passes
  // `open` when it wires the block into a disclosure row. Defaults to
  // true so any standalone use of the block (none today) still works.
  open = true,
}: {
  ingredientId: string | null;
  itemId: string | null;
  open?: boolean;
}) {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!ingredientId && !itemId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (ingredientId) params.set("ingredientId", ingredientId);
        if (itemId) params.set("itemId", itemId);
        const res = await fetch(`/api/review/item-events?${params.toString()}`, {
          method: "GET",
        });
        const data = (await res.json().catch(() => null)) as {
          events?: LedgerEvent[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.events) {
          setError(data?.error ?? `Load ${res.status}`);
          setEvents([]);
          return;
        }
        setEvents(data.events);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setEvents([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ingredientId, itemId]);

  // N7 §3f: body-only; the disclosure row + sub-line live on the caller
  // (PanelClosedRows). No kf-drawer__block wrapper, no h4.
  if (!open) return null;
  return (
    <div className="kf-dpn__ledger" aria-label="Change history">
      {events === null ? (
        <div className="kf-dpn__ledger-loading">Loading history...</div>
      ) : error ? (
        <div className="kf-dpn__ledger-empty">Could not load: {error}</div>
      ) : events.length === 0 ? (
        <div className="kf-dpn__ledger-empty">
          No edits yet. Rename / category / resale / pack changes will show here with who and when.
        </div>
      ) : (
        <ul className="kf-dpn__ledger-list">
          {events.slice(0, 10).map((e) => (
            <LedgerRowItem key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LedgerRowItem({ e }: { e: LedgerEvent }) {
  const { label, body } = describeEvent(e);
  const actor = e.actor ?? "-";
  return (
    <li className="kf-dpn__ledger-item">
      <span className="kf-dpn__ledger-kind">{label}</span>
      <span className="kf-dpn__ledger-body">{body}</span>
      <span className="kf-dpn__ledger-meta">
        <time dateTime={e.at} title={fmtDate(e.at, "time")}>{fmtDate(e.at, "time")}</time>
        {" · "}
        {actor}
        {" · "}
        {timeAgo(e.at)}
      </span>
    </li>
  );
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function describeEvent(e: LedgerEvent): { label: string; body: React.ReactNode } {
  const before = e.before ?? {};
  const after = e.after ?? {};
  if (e.kind === "ingredient_renamed") {
    const oldName = asStr(before.name);
    const newName = asStr(after.name);
    return {
      label: "Renamed",
      body: (
        <>
          {oldName ? <><strong>{oldName}</strong> → </> : null}
          <strong>{newName ?? "(unknown)"}</strong>
        </>
      ),
    };
  }
  if (e.kind === "ingredient_category_set") {
    const oldCat = asStr(before.category);
    const newCat = asStr(after.category);
    const oldSub = asStr(before.parent);
    const newSub = asStr(after.parent);
    return {
      label: "Category",
      body: (
        <>
          {oldCat || oldSub ? <>{oldCat ?? "Needs category"}{oldSub ? ` / ${oldSub}` : ""} → </> : null}
          <strong>{newCat ?? "Needs category"}{newSub ? ` / ${newSub}` : ""}</strong>
        </>
      ),
    };
  }
  if (e.kind === "ingredient_resale_set") {
    const next = after.resale === true;
    return {
      label: "Retail",
      body: <>Moved to <strong>{next ? "retail bucket" : "recipe coverage"}</strong></>,
    };
  }
  if (e.kind === "pack_override_set") {
    const packText = asStr(after.pack_text);
    const unit = asStr(after.billed_unit);
    return {
      label: "Pack size",
      body: (
        <>
          Set to <strong>{packText ?? "-"}</strong>
          {unit ? <> / {unit}</> : null} (manually entered)
        </>
      ),
    };
  }
  if (e.kind === "ingredient_merged") {
    const srcName = asStr(before.source_name);
    const tgtName = asStr(after.target_name);
    const moved =
      typeof after.moved_items === "number" ? after.moved_items : null;
    return {
      label: "Merged",
      body: (
        <>
          {srcName ? <><strong>{srcName}</strong></> : "This ingredient"} merged into{" "}
          <strong>{tgtName ?? "another"}</strong>
          {moved != null ? <> ({moved} items moved)</> : null}
        </>
      ),
    };
  }
  if (e.kind === "ingredient_merge_undo") {
    return { label: "Undo merge", body: <>Merge reversed; items restored.</> };
  }
  if (e.kind === "ingredient_created") {
    const name = asStr(after.name);
    return {
      label: "Created",
      body: (
        <>
          Ingredient <strong>{name ?? "(unknown)"}</strong> created
        </>
      ),
    };
  }
  if (e.kind === "ingredient_split_create") {
    const name = asStr(after.name);
    const movedIds = Array.isArray(after.moved_item_ids) ? after.moved_item_ids.length : null;
    return {
      label: "Split",
      body: (
        <>
          Split into new ingredient <strong>{name ?? "(unknown)"}</strong>
          {movedIds != null ? <> ({movedIds} items)</> : null}
        </>
      ),
    };
  }
  if (e.kind === "review_confirm") {
    const n = typeof after.confirmed === "number" ? after.confirmed : null;
    return {
      label: "Confirmed",
      body: n != null ? <>Confirmed <strong>{n}</strong> items</> : <>Confirmed</>,
    };
  }
  if (e.kind === "review_undo") {
    return { label: "Undo confirm", body: <>Reversed one confirm.</> };
  }
  // Fallback for any other kind - humanize via the shared helper.
  return {
    label: humanizeKind(e.kind, 1),
    body: <span className="kf-muted">(no details)</span>,
  };
}
