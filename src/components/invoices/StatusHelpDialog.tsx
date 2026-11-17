"use client";

// Small "?" dialog: two statuses of this train in the viewer's words,
// one line each. Focus-trapped, Escape closes, focus returns to the
// "?" button (the Toolbar owns that side).

import { useEffect, useRef } from "react";

export function StatusHelpDialog({
  fixWord,
  onClose,
}: {
  fixWord: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const items = panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (items.length === 0) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    // Pin focus to the Close button on open.
    const closeBtn = panelRef.current?.querySelector<HTMLButtonElement>("button[data-close]");
    closeBtn?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="kf-invoices-help__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="What the statuses mean"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="kf-invoices-help__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>What the statuses mean</h3>
        <dl>
          <dt>{fixWord}</dt>
          <dd>
            {fixWord === "Sent back"
              ? "The invoice went back to the site for a fix."
              : "The office sent this back for a fix."}
          </dd>
          <dt>With accounting</dt>
          <dd>In the office&apos;s hands. Nothing to do.</dd>
        </dl>
        <button
          type="button"
          data-close
          className="kf-btn kf-btn--primary"
          onClick={onClose}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
