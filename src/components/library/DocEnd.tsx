"use client";

// The close at the end of the article: Suggest an edit, Share,
// Back - plus a quiet "Your suggestions" link when the viewer has
// at least one note of their own. The first two dispatch the same
// custom events the top-bar toolbar dispatches; Back renders the
// same BackLink as the top bar so wording is consistent.

import { useCallback } from "react";
import Link from "next/link";
import { MessageSquarePlus, Share2, FileText } from "lucide-react";
import { BackLink } from "./BackLink";
import { DOC_TOOL_EVENT, type DocToolEventDetail } from "./docToolEvents";

export function DocEnd({
  docId,
  docTitle,
  ownerName,
  showYourSuggestions,
}: {
  docId: string;
  docTitle: string;
  ownerName: string | null;
  // Server tells the client whether to show the quiet "Your
  // suggestions" link; see `hasOwnSuggestions` in
  // src/lib/academy/suggestions.ts. Never a browser read.
  showYourSuggestions: boolean;
}) {
  const dispatch = useCallback(
    (kind: "share" | "suggest") => {
      try {
        window.dispatchEvent(
          new CustomEvent<DocToolEventDetail>(DOC_TOOL_EVENT, {
            detail: { kind, docId, docTitle },
          }),
        );
      } catch {
        // non-fatal
      }
    },
    [docId, docTitle],
  );
  const owner = ownerName ?? "the owner";
  return (
    <footer className="kf-lb-end" aria-label="End of document">
      <div className="kf-lb-end__row">
        <p className="kf-lb-end__line">
          <strong>Something wrong or out of date?</strong> It goes to {owner},
          with your name.
        </p>
        <div className="kf-lb-end__acts">
          <button
            type="button"
            className="kf-btn kf-btn--line"
            onClick={() => dispatch("suggest")}
          >
            <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
            <span>Suggest an edit</span>
          </button>
          <button
            type="button"
            className="kf-btn kf-btn--line"
            onClick={() => dispatch("share")}
          >
            <Share2 size={16} strokeWidth={1.75} aria-hidden />
            <span>Share</span>
          </button>
          <BackLink />
        </div>
      </div>
      {showYourSuggestions ? (
        <div className="kf-lb-end__your-row">
          <Link
            href="/library/suggestions/mine"
            className="kf-btn kf-btn--ghost kf-lb-end__your"
            prefetch={false}
          >
            <FileText size={14} strokeWidth={1.75} aria-hidden />
            <span>Your suggestions</span>
          </Link>
        </div>
      ) : null}
    </footer>
  );
}
