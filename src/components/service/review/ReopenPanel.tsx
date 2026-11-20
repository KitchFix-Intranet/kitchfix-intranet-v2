// Train 5: the Reopen panel. Sits under the "Submitted and on
// record" banner on the week check of a submitted V2 week, visible
// only to viewers the server has decided may reopen (canReopen is
// a boolean — the role never crosses the wire).
//
// Shape: one quiet button ("Reopen this week" / "Reopen these two
// weeks") opens the reason textarea in place. No modal. No "are
// you sure" prompt — the required reason is the pause (rule 6 of
// the master). Submit is one filled button, disabled until the
// reason is non-empty and under 280 characters. On success the
// page navigates to /service with the week's period open, and the
// calendar shows a one-line notice.
//
// Every refusal word comes from the server; the component never
// composes a message it can decide itself.

"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, TriangleAlert, Unlock } from "lucide-react";

interface Props {
  accountKey: string;
  slug: string;
  weekStart: string;
  isBiweeklyUnit: boolean;
}

type FormState =
  | { kind: "idle" }
  | { kind: "open"; reason: string; busy: boolean; err: string | null };

export function ReopenPanel({ accountKey, slug, weekStart, isBiweeklyUnit }: Props) {
  const router = useRouter();
  const [state, setState] = useState<FormState>({ kind: "idle" });

  const open = useCallback(() => {
    setState({ kind: "open", reason: "", busy: false, err: null });
  }, []);

  const cancel = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  const onReason = useCallback((val: string) => {
    setState((s) => (s.kind === "open" ? { ...s, reason: val.slice(0, 280), err: null } : s));
  }, []);

  const submit = useCallback(async () => {
    if (state.kind !== "open") return;
    const trimmed = state.reason.trim();
    if (!trimmed) {
      setState({ ...state, err: "A reason is required." });
      return;
    }
    setState({ ...state, busy: true, err: null });
    try {
      const res = await fetch("/api/service/reopen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountKey, weekStart, reason: trimmed }),
      });
      const payload = await res.json();
      if (!payload.ok) {
        setState({
          kind: "open",
          reason: state.reason,
          busy: false,
          err: typeof payload.message === "string" ? payload.message : "That did not land. Try again.",
        });
        return;
      }
      // Land on the calendar with the period that holds the week.
      // Fix 5 (2026-11-20): the "open again" line is built from the
      // SERVER's unit span, not guessed on the client. Pass the
      // server's `unitSpanStart`, `unitSpanEnd` and `isBiweekly`
      // through URL params so CalendarPage reads them directly.
      const period = payload.holdingPeriod as { fiscal_year: number; period_no: number } | null;
      const unitEnd = typeof payload.unitSpanEnd === "string" ? payload.unitSpanEnd : "";
      const unitStart = typeof payload.unitSpanStart === "string" ? payload.unitSpanStart : weekStart;
      const isPair = payload.isBiweekly === true ? "1" : "0";
      const params = new URLSearchParams();
      params.set("site", slug);
      if (period) {
        params.set("fy", String(period.fiscal_year));
        params.set("p", String(period.period_no));
      }
      params.set("reopened", unitStart);
      if (unitEnd) params.set("rend", unitEnd);
      params.set("rpair", isPair);
      router.replace(`/service?${params.toString()}`);
      router.refresh();
    } catch {
      // Small 10 (2026-11-20): never surface the raw script error to
      // the person. One plain sentence they can act on.
      setState({
        kind: "open",
        reason: state.reason,
        busy: false,
        err: "That did not go through. Check the connection and try again.",
      });
    }
  }, [state, accountKey, slug, weekStart, router]);

  if (state.kind === "idle") {
    const label = isBiweeklyUnit ? "Reopen these two weeks" : "Reopen this week";
    return (
      <div className="kf-sc-rv-reopen">
        <button
          type="button"
          className="kf-btn kf-btn--line"
          onClick={open}
        >
          <Unlock size={18} strokeWidth={1.5} aria-hidden /> {label}
        </button>
      </div>
    );
  }

  const title = isBiweeklyUnit ? "Why reopen these two weeks?" : "Why reopen this week?";
  const chars = state.reason.length;
  const canSubmit = state.reason.trim().length > 0 && !state.busy;

  return (
    <div className="kf-sc-rv-reopen is-open" role="group" aria-label={title}>
      <h4 className="kf-sc-rv-reopen__title">{title}</h4>
      <label className="kf-sc-rv-reopen__label" htmlFor={`reopen-${weekStart}`}>
        Reason
      </label>
      <textarea
        id={`reopen-${weekStart}`}
        className="kf-sc-rv-reopen__input"
        rows={3}
        value={state.reason}
        maxLength={280}
        onChange={(e) => onReason(e.target.value)}
        disabled={state.busy}
        autoFocus
      />
      <p className="kf-sc-rv-reopen__hint">
        Saved with your name and the time. {chars} of 280.
      </p>
      {state.err ? (
        <p className="kf-sc-rv-reopen__err" role="alert">
          <TriangleAlert size={16} strokeWidth={1.5} aria-hidden /> {state.err}
        </p>
      ) : null}
      <div className="kf-sc-rv-reopen__acts">
        <button
          type="button"
          className="kf-btn kf-btn--ghost"
          onClick={cancel}
          disabled={state.busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`kf-btn kf-btn--primary${state.busy ? " is-busy" : ""}`}
          onClick={submit}
          disabled={!canSubmit}
        >
          {state.busy ? <RefreshCw size={18} strokeWidth={1.5} aria-hidden /> : <Unlock size={18} strokeWidth={1.5} aria-hidden />}
          <span>{state.busy ? "Reopening" : (isBiweeklyUnit ? "Reopen these two weeks" : "Reopen this week")}</span>
        </button>
      </div>
    </div>
  );
}
