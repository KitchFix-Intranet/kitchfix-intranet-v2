"use client";

// Lane-local Sheet / dialog primitive. One focus trap, one
// Escape handler, one return-focus path - shared by:
//   - B9 same-file-twice dialog
//   - C7 calendar (desk-popover + phone-sheet both via this)
//   - C9 duplicate stop block (phone sheet)
//   - D2 "See the page" sheet
//   - D6 60-day confirmation sheet (phone)
//   - D7 vendor picker + calendar as sheets (phone)
//
// On viewports 860 px and under it covers the viewport (full width,
// full height); on wider viewports it draws as a centered modal
// with --sp-sheet-max width. Train 2b correction 13 asked for one
// primitive, used everywhere, not a focus trap per screen.

import { useCallback, useEffect, useRef } from "react";
import { X as XIcon } from "lucide-react";

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), ' +
  '[href]:not([tabindex="-1"]), ' +
  'input:not([disabled]):not([tabindex="-1"]), ' +
  'select:not([disabled]):not([tabindex="-1"]), ' +
  'textarea:not([disabled]):not([tabindex="-1"]), ' +
  '[tabindex]:not([tabindex="-1"])';

interface Props {
  // Accessible name for the dialog. Read by screen readers.
  title: string;
  // Called when the user closes the sheet (Escape, X, or
  // backdrop). The parent unmounts the Sheet in response.
  onClose: () => void;
  // Optional footer actions. Rendered in the sheet's foot row.
  footer?: React.ReactNode;
  // Variant. "centered" is a desk-ish modal that still goes
  // full-width on phones via @media; "fullsheet" always covers
  // the viewport (used for the page-view sheet D2).
  variant?: "centered" | "fullsheet";
  // Hide the header's close button (the parent provides its own
  // close path inside the body). Default false.
  hideClose?: boolean;
  children: React.ReactNode;
}

export function Sheet({ title, onClose, footer, variant = "centered", hideClose = false, children }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Remember what had focus before the sheet opened; give it back on
  // close. Falls back to document.body (no-op) when nothing.
  useEffect(() => {
    const previously = document.activeElement;
    if (previously instanceof HTMLElement) returnFocusRef.current = previously;
    // Move focus into the sheet, preferring an element marked
    // data-autofocus, else the first focusable, else the sheet.
    const root = rootRef.current;
    if (root) {
      const auto = root.querySelector<HTMLElement>("[data-autofocus]");
      if (auto) auto.focus();
      else {
        const first = root.querySelector<HTMLElement>(FOCUSABLE);
        if (first) first.focus();
        else root.focus();
      }
    }
    return () => {
      // Return focus (best effort; the element may have been
      // detached).
      const el = returnFocusRef.current;
      if (el && typeof el.focus === "function" && document.contains(el)) el.focus();
    };
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const root = rootRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusables.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }, [onClose]);

  const onBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div
      className={`kf-inv-sheet kf-inv-sheet--${variant}`}
      role="presentation"
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        ref={rootRef}
        className="kf-inv-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="kf-inv-sheet__head">
          <span className="kf-inv-sheet__title">{title}</span>
          {hideClose ? null : (
            <button
              type="button"
              className="kf-inv-sheet__close"
              aria-label="Close"
              onClick={onClose}
            >
              <XIcon size={20} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        <div className="kf-inv-sheet__body">{children}</div>
        {footer ? <div className="kf-inv-sheet__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
