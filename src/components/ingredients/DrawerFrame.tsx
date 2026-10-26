"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

type Props = {
  closeHref: string;
  labelledBy: string;
  children: ReactNode;
};

const EXIT_MS = 200;

// Client wrapper for the vendor-item drawer. The drawer is a server
// component gated on a URL param (?drawer=<id>); a plain <Link> close
// unmounts before any exit keyframe can play. This wrapper plays
// kf-slide-out + kf-fade-out first, then calls router.push(closeHref).
// Also: traps Tab, closes on Escape, focuses the close button on open,
// restores focus to the originating row on close.
export function DrawerFrame({ closeHref, labelledBy, children }: Props) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  const close = () => {
    if (closing) return;
    setClosing(true);
    try {
      const rowId = sessionStorage.getItem("kf.drawer.from-row");
      if (rowId) {
        const row = document.querySelector(`[data-row-id="${rowId}"]`) as HTMLElement | null;
        row?.focus();
      }
    } catch {
      // non-fatal
    }
    window.setTimeout(() => router.push(closeHref), EXIT_MS);
  };

  useEffect(() => {
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && asideRef.current) {
        const focusables = asideRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"], input, select, textarea'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        className={`kf-drawer__backdrop${closing ? " is-closing" : ""}`}
        onClick={close}
        aria-hidden
      />
      <aside
        ref={asideRef}
        className={`kf-drawer${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <button
          type="button"
          ref={closeBtnRef}
          className="kf-drawer__close"
          onClick={close}
          aria-label="Close"
        >
          <X size={20} strokeWidth={1.5} />
        </button>
        {children}
      </aside>
    </>
  );
}
