"use client";

// A single row in the owner's suggestions list, with Used /
// No-change actions. The row vanishes when it closes.
//
// Both the issue_text and the suggested_text are rendered inside
// React text nodes - never dangerouslySetInnerHTML. Any angle
// brackets a reader typed come back as literal characters, which
// is exactly what the probe checks.

import { useState, useTransition } from "react";
import { fmtDate } from "@/lib/fmt";
import { toast } from "@/components/ui/Toaster";

export type SuggestionRowView = {
  id: string;
  doc_id: string;
  doc_title: string | null;
  section_key: string | null;
  section_title: string | null;
  doc_version: string | null;
  reporter_email: string | null;
  issue_text: string;
  suggested_text: string | null;
  created_at: string | null;
};

export function SuggestionRow({ row }: { row: SuggestionRowView }) {
  const [closed, setClosed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const partLabel = row.section_title
    ? row.section_title
    : "The whole document";
  const when = row.created_at ? fmtDate(row.created_at, "time") : "";
  // The sender's email is the one place a reader's address is
  // shown. Never includes the owner's email. Rendered as text.
  const sender = row.reporter_email ?? "(unknown)";

  const handle = (outcome: "used" | "no_change") => {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/academy/library/suggestions/${encodeURIComponent(row.id)}/handle`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ outcome }),
          },
        );
        if (res.ok) {
          setClosed(true);
          toast(outcome === "used" ? "Marked Used." : "Marked No change.");
          return;
        }
        if (res.status === 404) {
          setClosed(true);
          toast("That note was already handled.");
          return;
        }
        setErr("That did not take. Try again in a moment.");
      } catch {
        setErr("That did not take. Try again in a moment.");
      }
    });
  };

  if (closed) return null;

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
      </header>
      <p className="kf-lb-sug-row__body">{row.issue_text}</p>
      {row.suggested_text ? (
        <details className="kf-lb-sug-row__wording">
          <summary>Reader&apos;s wording</summary>
          <pre className="kf-lb-sug-row__pre">{row.suggested_text}</pre>
        </details>
      ) : null}
      <footer className="kf-lb-sug-row__foot">
        <span className="kf-lb-sug-row__sender">
          From <strong>{sender}</strong> {when}
        </span>
        <div className="kf-lb-sug-row__acts">
          <button
            type="button"
            className="kf-btn kf-btn--primary"
            onClick={() => handle("used")}
            disabled={pending}
          >
            Used
          </button>
          <button
            type="button"
            className="kf-btn kf-btn--line"
            onClick={() => handle("no_change")}
            disabled={pending}
          >
            No change
          </button>
        </div>
      </footer>
      {err ? <p className="kf-lb-err" role="alert">{err}</p> : null}
    </article>
  );
}
