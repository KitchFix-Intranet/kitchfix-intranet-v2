// Notes-and-history fold inside the day drawer. Closed by default;
// the first open triggers one wave of three reads (bounded to one
// day). Writes a note through POST /api/service/day-note; the
// response carries the fresh view so the fold updates in place.
//
// This is a client component because of the fetch + open/close state.
// Nothing crosses the shared `src/app/components.css` surface; the
// shapes it uses are already in service.css.

"use client";

import { useCallback, useState } from "react";
import {
  ChevronDown, ChevronUp, MessageSquare, RefreshCw, TriangleAlert, Save,
} from "lucide-react";
import type { NotesHistoryView, RenderItem } from "@/lib/sc/notesHistory/types";
import {
  describeFirstEntered,
  describeActualChange,
  describeActualDelete,
  describeDeleteGroup,
} from "@/lib/sc/notesHistory/formatHistoryLine";

interface Props {
  accountKey: string;
  serviceDate: string;
  timezone: string | null;
  // The route disables writes when the day is locked; the component
  // suppresses the add-a-note form when readOnly is true so the
  // control is not drawn disabled.
  readOnly?: boolean;
}

export function NotesAndHistory({ accountKey, serviceDate, timezone, readOnly = false }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NotesHistoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const url = `/api/service/day-note?account=${encodeURIComponent(accountKey)}&date=${encodeURIComponent(serviceDate)}`;
      const res = await fetch(url, { method: "GET" });
      const payload = await res.json();
      if (!payload.ok) {
        setErr(payload.message ?? "Could not load notes.");
        return;
      }
      setView(payload.view as NotesHistoryView);
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [accountKey, serviceDate]);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) void load();
  }, [open, loaded, load]);

  const addNote = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/service/day-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountKey, serviceDate, note: text }),
      });
      const payload = await res.json();
      if (!payload.ok) {
        setErr(payload.message ?? "Could not add the note.");
        return;
      }
      setDraft("");
      if (payload.view) setView(payload.view as NotesHistoryView);
      else void load();  // reload if the server did not carry the view
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, accountKey, serviceDate, load]);

  const latest = view?.items?.[0] ?? null;
  const totalLabel = view ? ` (${view.totalCount})` : "";
  const subLine = latest
    ? `Last: ${lastSubLabel(latest)}, ${shortClock(getAtOf(latest), timezone)}`
    : "Nothing recorded yet";

  return (
    <div className={`kf-sc-notebox${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="kf-sc-fold"
        aria-expanded={open}
        onClick={toggle}
      >
        <MessageSquare size={18} strokeWidth={1.5} aria-hidden />
        <span>
          <b>Notes and history{totalLabel}</b>
          <small>{subLine}</small>
        </span>
        {open ? <ChevronUp size={20} strokeWidth={1.5} aria-hidden /> : <ChevronDown size={20} strokeWidth={1.5} aria-hidden />}
      </button>

      {open ? (
        <div className="kf-sc-notebox__in">
          {busy && !view ? (
            <p className="kf-sc-muted kf-sc-notebox__muted">Loading notes and history...</p>
          ) : null}

          {err ? (
            <p className="kf-sc-notebox__err" role="alert">
              <TriangleAlert size={16} strokeWidth={1.5} aria-hidden /> {err}
            </p>
          ) : null}

          {view && view.items.length === 0 ? (
            <p className="kf-sc-muted kf-sc-notebox__muted">Nothing here yet.</p>
          ) : null}

          {view && view.items.length > 0 ? (
            <ol className="kf-sc-ledger" aria-label="Day history, newest first">
              {view.items.map((it, i) => (
                <li key={keyOf(it, i)}>
                  <span className="kf-sc-ledger__when">
                    {shortClock(getAtOf(it), timezone)}
                  </span>
                  <span className="kf-sc-ledger__who">
                    {whoOf(it)}
                  </span>
                  <p>{bodyOf(it)}</p>
                </li>
              ))}
            </ol>
          ) : null}

          {!readOnly ? (
            <div className="kf-sc-notebox__add">
              <label className="kf-sc-notebox__label" htmlFor={`note-${serviceDate}`}>Add a note</label>
              <textarea
                id={`note-${serviceDate}`}
                className="kf-sc-notebox__input"
                rows={2}
                value={draft}
                maxLength={2000}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
              />
              <div className="kf-sc-notebox__foot">
                <span className="kf-sc-muted kf-sc-notebox__hint">
                  Saved with your name and the time.
                </span>
                <button
                  type="button"
                  className={`kf-btn kf-btn--line${busy ? " is-busy" : ""}`}
                  onClick={addNote}
                  disabled={busy || !draft.trim()}
                >
                  {busy ? <RefreshCw size={16} strokeWidth={1.5} aria-hidden /> : <Save size={16} strokeWidth={1.5} aria-hidden />}
                  Add note
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────

function getAtOf(it: RenderItem): string {
  switch (it.kind) {
    case "first_entered":
    case "actual_change":
    case "actual_delete":
    case "note":
      return it.at;
    case "actual_delete_group":
      return it.firstAt;
  }
}

function whoOf(it: RenderItem): string {
  switch (it.kind) {
    case "first_entered":
      return it.authorDisplayName ?? "Someone";
    case "actual_change":
    case "actual_delete":
      return it.authorDisplayName ?? "Someone";
    case "actual_delete_group":
      return it.authorDisplayName ?? "Someone";
    case "note":
      return it.authorDisplayName ?? "";  // legacy note: no name
  }
}

function bodyOf(it: RenderItem): string {
  switch (it.kind) {
    case "first_entered":        return describeFirstEntered(it);
    case "actual_change":        return describeActualChange(it);
    case "actual_delete":        return describeActualDelete(it);
    case "actual_delete_group":  return describeDeleteGroup(it);
    case "note":                 return it.text;
  }
}

function lastSubLabel(it: RenderItem): string {
  const who = whoOf(it);
  return who || "a note";
}

function keyOf(it: RenderItem, i: number): string {
  switch (it.kind) {
    case "actual_change":
    case "actual_delete":
      return `${it.kind}-${it.at}-${it.serviceId}`;
    case "actual_delete_group":
      return `grp-${it.firstAt}-${it.services.length}`;
    case "first_entered":
      return `first-${it.at}`;
    case "note":
      return `note-${it.at}-${i}`;
  }
}

function shortClock(iso: string, timezone: string | null): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const tz = timezone || "America/Chicago";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(t));
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  const h = parts.find((p) => p.type === "hour")?.value ?? "";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "";
  const ap = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  if (!m || !d || !h || !mm || !ap) return "";
  return `${m} ${d}, ${h}:${mm} ${ap.toUpperCase()}`;
}

// Export so the day drawer can mount it below the body.
export default NotesAndHistory;
