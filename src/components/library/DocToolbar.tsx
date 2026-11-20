"use client";

// Four controls on the document page's top bar:
//   Details, Share, Print, Suggest an edit
//
// Each opens a panel inside the page, not a URL-param drawer: the
// L3 panels are state-driven so a half-written suggestion survives
// the whole document being clicked around, and the closed/opened
// state never lands in the address (no referrer leak + the Back
// button never dances through drawer opens).
//
// Behaviour at each width:
//   >=1280 (roomy)   - every control carries its text next to the
//                      icon.
//   1024-1279        - Details stays text; Share, Print, Suggest an
//                      edit are icon-only (title + aria-label carry
//                      the word for sighted + SR users).
//   <1024 (phone)    - Details is hidden from this toolbar: the
//                      About column is NOT showing at this width,
//                      but the whole About block already appears
//                      stacked above the article on phone, so the
//                      four-control top bar collapses to three.
//                      Print is hidden on phone per the spec.
//                      That leaves Share and Suggest an edit at
//                      48px icon-only hit targets.
//
// This component is inside the @topbar/library/[docId] slot's
// render tree; the control panels mount inside the page tree via
// DocControlsIsland (which listens for the custom events the icons
// dispatch here). Keeps the slot small and avoids drilling props
// through parallel routes.

import { useCallback } from "react";
import {
  Info,
  Share2,
  Printer,
  MessageSquarePlus,
} from "lucide-react";
import { DOC_TOOL_EVENT, type DocToolEventDetail } from "./docToolEvents";

export type DocToolbarProps = {
  // The document id is in the URL (e.g. /library/POL-001), but the
  // slot cannot read a client param without re-routing; the page
  // passes it in so Print's filename and Share's link both resolve
  // without an extra fetch.
  docId: string;
  docTitle: string;
};

export function DocToolbar({ docId, docTitle }: DocToolbarProps) {
  const dispatch = useCallback(
    (kind: DocToolEventDetail["kind"]) => {
      // Guard against SSR calls: the component is "use client", but
      // the toolbar can mount with the panels not yet hydrated.
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

  return (
    <div className="kf-lb-tools__row" role="group" aria-label="Document controls">
      <button
        type="button"
        className="kf-btn kf-btn--line kf-lb-ta kf-lb-ta--details"
        onClick={() => dispatch("details")}
        aria-label="Details"
        title="Details"
      >
        <Info size={16} strokeWidth={1.75} aria-hidden />
        <span>Details</span>
      </button>
      <button
        type="button"
        className="kf-btn kf-btn--line kf-lb-ta kf-lb-ta--share"
        onClick={() => dispatch("share")}
        aria-label="Share"
        title="Share"
      >
        <Share2 size={16} strokeWidth={1.75} aria-hidden />
        <span>Share</span>
      </button>
      <button
        type="button"
        className="kf-btn kf-btn--line kf-lb-ta kf-lb-ta--print"
        onClick={() => {
          try {
            window.print();
          } catch {
            // non-fatal
          }
        }}
        aria-label="Print this document"
        title="Print"
      >
        <Printer size={16} strokeWidth={1.75} aria-hidden />
        <span>Print</span>
      </button>
      <button
        type="button"
        className="kf-btn kf-btn--line kf-lb-ta kf-lb-ta--sug"
        onClick={() => dispatch("suggest")}
        aria-label="Suggest an edit"
        title="Suggest an edit"
      >
        <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
        <span>Suggest an edit</span>
      </button>
    </div>
  );
}
