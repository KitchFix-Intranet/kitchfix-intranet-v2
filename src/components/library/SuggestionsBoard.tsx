"use client";

// Owner-only Suggestions board. Three tabs: Open, Accepted (not
// changed yet), Closed. Clicking a tab updates ?list= so a shared
// link lands on the same list. Each tab shows its count.
//
// A note that is moved by the owner's action re-renders in place:
// the action route returns ok and the component replays the move
// locally without a full-page refresh. Any failure is a designed
// state and keeps the note where it is.
//
// Plain text only - every reader-written field is rendered inside
// React text nodes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ExternalLink, Mail, X } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtDate } from "@/lib/fmt";
import type {
  ListResult,
  OwnerListRow,
  ScreenState,
} from "@/lib/academy/suggestions";
import { screenStateFor } from "@/lib/academy/suggestions";

const HANDLED_NOTE_MAX = 2000;

type TabKey = "open" | "accepted" | "closed";

type Props = {
  openList: ListResult;
  acceptedList: ListResult;
  closedList: ListResult;
  initial: TabKey;
};

type Mutable = {
  open: OwnerListRow[];
  accepted: OwnerListRow[];
  closed: OwnerListRow[];
};

export function SuggestionsBoard({ openList, acceptedList, closedList, initial }: Props) {
  const router = useRouter();
  const sp = useSearchParams();

  // Local state so moves between tabs happen without a round trip.
  // If a server page load changes the lists (new note arrived), the
  // props update and we re-seed state.
  const seed = useMemo<Mutable>(
    () => ({
      open: openList.ok ? openList.rows : [],
      accepted: acceptedList.ok ? acceptedList.rows : [],
      closed: closedList.ok ? closedList.rows : [],
    }),
    [openList, acceptedList, closedList],
  );
  const [lists, setLists] = useState<Mutable>(seed);
  useEffect(() => setLists(seed), [seed]);

  const [tab, setTab] = useState<TabKey>(initial);
  const prevTab = useRef<TabKey>(initial);

  const setTabAndUrl = useCallback(
    (next: TabKey) => {
      setTab(next);
      prevTab.current = next;
      const params = new URLSearchParams(sp?.toString() ?? "");
      if (next === "open") params.delete("list");
      else params.set("list", next);
      const qs = params.toString();
      router.replace(qs ? `/library/suggestions?${qs}` : "/library/suggestions", {
        scroll: false,
      });
    },
    [router, sp],
  );

  // When the row count in each list changes, update the label counts.
  const counts = {
    open: lists.open.length,
    accepted: lists.accepted.length,
    closed: lists.closed.length,
  };

  const anyFetchError =
    !openList.ok || !acceptedList.ok || !closedList.ok;

  // Move a row to a new local list by id, dropping it from every
  // other list first so a replay of the same action does not
  // duplicate.
  const applyMove = useCallback(
    (
      id: string,
      target: TabKey,
      patch: Partial<OwnerListRow>,
    ) => {
      setLists((prev) => {
        const found =
          prev.open.find((r) => r.id === id) ||
          prev.accepted.find((r) => r.id === id) ||
          prev.closed.find((r) => r.id === id);
        if (!found) return prev;
        const patched = { ...found, ...patch };
        return {
          open: (target === "open"
            ? [patched, ...prev.open.filter((r) => r.id !== id)]
            : prev.open.filter((r) => r.id !== id)),
          accepted: (target === "accepted"
            ? [patched, ...prev.accepted.filter((r) => r.id !== id)]
            : prev.accepted.filter((r) => r.id !== id)),
          closed: (target === "closed"
            ? [patched, ...prev.closed.filter((r) => r.id !== id)]
            : prev.closed.filter((r) => r.id !== id)),
        };
      });
    },
    [],
  );

  return (
    <section className="kf-lb-sugs" aria-label="Suggestions">
      <header className="kf-lb-sugs__head">
        <h1 className="kf-lb-sugs__h1">Suggestions</h1>
        <p className="kf-lb-sugs__sub">
          Reader notes. Accept to work on one, Decline when the document is
          already right. Accepting does not change the document yet - a change
          is made in the document&apos;s source for now.
        </p>
      </header>

      <nav className="kf-lb-sugs-tabs" aria-label="Lists">
        <button
          type="button"
          className="kf-lb-sugs-tab"
          aria-current={tab === "open" ? "page" : undefined}
          onClick={() => setTabAndUrl("open")}
        >
          Open
          <span className="kf-lb-sugs-tab__c">{counts.open}</span>
        </button>
        <button
          type="button"
          className="kf-lb-sugs-tab"
          aria-current={tab === "accepted" ? "page" : undefined}
          onClick={() => setTabAndUrl("accepted")}
        >
          Accepted - not changed yet
          <span className="kf-lb-sugs-tab__c">{counts.accepted}</span>
        </button>
        <button
          type="button"
          className="kf-lb-sugs-tab"
          aria-current={tab === "closed" ? "page" : undefined}
          onClick={() => setTabAndUrl("closed")}
        >
          Closed
          <span className="kf-lb-sugs-tab__c">{counts.closed}</span>
        </button>
      </nav>

      {anyFetchError ? (
        <div className="kf-error" role="alert">
          <div className="kf-error__title">Could not read every list</div>
          <div className="kf-error__body">
            One of the lists did not come back. Try reloading in a moment.
          </div>
        </div>
      ) : null}

      <ListPanel
        name="open"
        active={tab}
        rows={lists.open}
        onMove={applyMove}
      />
      <ListPanel
        name="accepted"
        active={tab}
        rows={lists.accepted}
        onMove={applyMove}
      />
      <ListPanel
        name="closed"
        active={tab}
        rows={lists.closed}
        onMove={applyMove}
      />
    </section>
  );
}

function ListPanel({
  name,
  active,
  rows,
  onMove,
}: {
  name: TabKey;
  active: TabKey;
  rows: OwnerListRow[];
  onMove: (id: string, target: TabKey, patch: Partial<OwnerListRow>) => void;
}) {
  if (name !== active) return null;
  if (rows.length === 0) {
    return (
      <section
        className="kf-empty"
        role="status"
        aria-label={`No ${name} suggestions`}
      >
        <div className="kf-empty__icon" aria-hidden />
        <div>
          <h3 className="kf-empty__title">{emptyTitleFor(name)}</h3>
          <p className="kf-empty__body">{emptyBodyFor(name)}</p>
        </div>
        {name !== "open" ? (
          <Link href="/library/suggestions" className="kf-btn kf-btn--primary">
            Back to Open
          </Link>
        ) : (
          <Link href="/library" className="kf-btn kf-btn--primary">
            Go to the Library
          </Link>
        )}
      </section>
    );
  }
  return (
    <div className="kf-lb-sugs__list">
      {rows.map((r) => (
        <SuggestionRow key={r.id} row={r} onMove={onMove} />
      ))}
    </div>
  );
}

function emptyTitleFor(name: TabKey): string {
  if (name === "open") return "Nothing open";
  if (name === "accepted") return "Nothing waiting to be done";
  return "Nothing closed";
}

function emptyBodyFor(name: TabKey): string {
  if (name === "open") return "No new reader notes are waiting.";
  if (name === "accepted")
    return "Notes you accept show up here until you press Mark as done.";
  return "Closed notes land here. Nothing has been handled yet.";
}

function SuggestionRow({
  row,
  onMove,
}: {
  row: OwnerListRow;
  onMove: (id: string, target: TabKey, patch: Partial<OwnerListRow>) => void;
}) {
  const state: ScreenState = screenStateFor(row.status, row.handled_outcome);
  const [decliningOpen, setDecliningOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (decliningOpen) {
      // Wait a tick so the element is visible.
      const t = window.setTimeout(() => reasonRef.current?.focus(), 20);
      return () => window.clearTimeout(t);
    }
    return;
  }, [decliningOpen]);

  const whenCreated = row.created_at ? fmtDate(row.created_at, "time") : "";
  const partLabel = row.section_title ?? "The whole document";
  const sender = row.reporter_email ?? "(unknown)";
  const handledWhen = row.handled_at ? fmtDate(row.handled_at, "time") : "";

  async function act(
    action: "accept" | "mark_done" | "decline" | "reopen",
    extra: { reason?: string } = {},
  ) {
    setErr(null);
    setPending(true);
    try {
      const res = await fetch(
        `/api/academy/library/suggestions/${encodeURIComponent(row.id)}/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, reason: extra.reason ?? null }),
        },
      );
      if (res.ok) {
        const now = new Date().toISOString();
        if (action === "accept") {
          onMove(row.id, "accepted", {
            status: "in_progress",
            handled_outcome: "used",
            handled_by: row.handled_by, // the server set this, but the
            handled_at: now,             // local optimistic UI keeps a
            handled_note: null,          // consistent view.
          });
          toast("Accepted. The document is not changed yet.");
        } else if (action === "mark_done") {
          onMove(row.id, "closed", {
            status: "closed",
            handled_outcome: "used",
            handled_at: now,
          });
          toast("Marked as done.");
        } else if (action === "decline") {
          onMove(row.id, "closed", {
            status: "closed",
            handled_outcome: "no_change",
            handled_at: now,
            handled_note: (extra.reason ?? "").trim() || null,
          });
          toast("Declined.");
        } else if (action === "reopen") {
          onMove(row.id, "open", {
            status: "open",
            handled_outcome: null,
            handled_by: null,
            handled_at: null,
            handled_note: null,
          });
          toast("Put back to Open.");
        }
        setDecliningOpen(false);
        setReason("");
        // Return focus to the control that opened the step, when
        // decline closed; otherwise focus falls back to document
        // body (standard React behaviour).
        if (triggerRef.current) {
          try {
            triggerRef.current.focus();
          } catch {
            // non-fatal
          }
        }
        return;
      }
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        // ignore
      }
      const code = (payload as { error?: string } | null)?.error ?? "server_error";
      setErr(messageForError(code));
    } catch {
      setErr("That did not take. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  // "Open the document here" href: carry ?from=/library/suggestions
  // so BackLink on the document page lands back here.
  const docHref = (() => {
    const base = `/library/${row.doc_id}`;
    const q = new URLSearchParams();
    q.set("from", "/library/suggestions");
    const anchor = row.section_key ? `#${row.section_key}` : "";
    return `${base}?${q.toString()}${anchor}`;
  })();

  const mailtoHref = (() => {
    const to = row.reporter_email ?? "";
    const subject = `Your note on ${row.doc_id}${row.doc_title ? ` - ${row.doc_title}` : ""}`;
    const header = `About ${row.doc_id}${row.doc_title ? ` (${row.doc_title})` : ""}`;
    const part = row.section_title ? `\nPart: ${row.section_title}` : "";
    const quoted = (row.issue_text || "").split("\n").map((l) => `> ${l}`).join("\n");
    const body = `${header}${part}\n\nYou wrote:\n${quoted}\n\n`;
    return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  })();

  return (
    <article className="kf-lb-sug-row" aria-label={`Suggestion on ${row.doc_id}`}>
      <header className="kf-lb-sug-row__head">
        <span className="kf-lb-sug-row__id">{row.doc_id}</span>
        {row.doc_title ? (
          <span className="kf-lb-sug-row__title">{row.doc_title}</span>
        ) : null}
        <span className="kf-lb-sug-row__meta">
          Part: <strong>{partLabel}</strong>
          {row.doc_version ? ` - v${row.doc_version}` : ""}
        </span>
        <StatePill state={state} />
      </header>
      <p className="kf-lb-sug-row__body">{row.issue_text}</p>
      {row.suggested_text ? (
        <section
          className="kf-lb-sug-row__wordblock"
          aria-label="Reader's wording"
        >
          <span className="kf-lb-field__l">Reader&apos;s wording</span>
          <pre className="kf-lb-sug-row__pre">{row.suggested_text}</pre>
        </section>
      ) : null}
      {state === "declined" && row.handled_note ? (
        <section className="kf-lb-sug-row__reason" aria-label="Decline reason">
          <span className="kf-lb-field__l">Reason given</span>
          <p>{row.handled_note}</p>
        </section>
      ) : null}
      <footer className="kf-lb-sug-row__foot">
        <div className="kf-lb-sug-row__meta-row">
          <span className="kf-lb-sug-row__sender">
            From <strong>{sender}</strong> {whenCreated}
          </span>
          {state !== "open" && handledWhen ? (
            <span className="kf-lb-sug-row__meta">
              {state === "accepted"
                ? `Accepted ${handledWhen}`
                : state === "done"
                ? `Done ${handledWhen}`
                : state === "declined"
                ? `Declined ${handledWhen}`
                : handledWhen}
            </span>
          ) : null}
        </div>
        <div className="kf-lb-sug-row__acts">
          <Link
            href={docHref}
            className="kf-btn kf-btn--line"
            prefetch={false}
          >
            <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
            <span>Open the document here</span>
          </Link>
          <a
            className="kf-btn kf-btn--line"
            href={mailtoHref}
            aria-label={`Reply by email to ${sender}`}
          >
            <Mail size={16} strokeWidth={1.75} aria-hidden />
            <span>Reply</span>
          </a>
          {state === "open" ? (
            <>
              <button
                type="button"
                className="kf-btn kf-btn--primary"
                onClick={() => act("accept")}
                disabled={pending}
              >
                Accept
              </button>
              <button
                type="button"
                className="kf-btn kf-btn--line"
                onClick={() => {
                  setDecliningOpen(true);
                }}
                disabled={pending}
                ref={triggerRef}
              >
                Decline
              </button>
            </>
          ) : null}
          {state === "accepted" ? (
            <>
              <button
                type="button"
                className="kf-btn kf-btn--primary"
                onClick={() => act("mark_done")}
                disabled={pending}
              >
                Mark as done
              </button>
              <button
                type="button"
                className="kf-btn kf-btn--line"
                onClick={() => {
                  setDecliningOpen(true);
                }}
                disabled={pending}
                ref={triggerRef}
              >
                Decline
              </button>
            </>
          ) : null}
          {state !== "open" ? (
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={() => act("reopen")}
              disabled={pending}
            >
              Put back to Open
            </button>
          ) : null}
        </div>
      </footer>
      {decliningOpen ? (
        <section
          className="kf-lb-sug-row__decline"
          aria-label="Decline this note"
        >
          <label className="kf-lb-field">
            <span className="kf-lb-field__l">
              Why, in one sentence (optional)
            </span>
            <textarea
              ref={reasonRef}
              className="kf-lb-field__ctl kf-lb-field__ctl--ta"
              rows={3}
              maxLength={HANDLED_NOTE_MAX}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
            <span className="kf-lb-field__count">
              {reason.length} / {HANDLED_NOTE_MAX}
            </span>
          </label>
          <div className="kf-lb-sug-row__decline-acts">
            <button
              type="button"
              className="kf-btn kf-btn--primary"
              onClick={() => act("decline", { reason })}
              disabled={pending}
            >
              Decline this note
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--ghost"
              onClick={() => {
                setDecliningOpen(false);
                setReason("");
              }}
              disabled={pending}
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
              <span>Cancel</span>
            </button>
          </div>
        </section>
      ) : null}
      {err ? (
        <p className="kf-lb-err" role="alert">
          {err}
        </p>
      ) : null}
    </article>
  );
}

function StatePill({ state }: { state: ScreenState }) {
  if (state === "open") return null; // the Open tab already says so
  const label =
    state === "accepted"
      ? "Accepted - not changed yet"
      : state === "done"
      ? "Done"
      : state === "declined"
      ? "Declined"
      : "Other";
  return <span className={`kf-pill kf-pill--${state}`}>{label}</span>;
}

function messageForError(code: string): string {
  switch (code) {
    case "not_found":
      return "That note is no longer there.";
    case "wrong_state":
      return "That move is not allowed from this state. Reload to see where it is now.";
    case "reason_too_long":
      return "The reason is too long. Trim it and try again.";
    default:
      return "That did not take. Try again in a moment.";
  }
}
