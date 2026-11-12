"use client";

// DrawerFrame-style wrapper for the person card. The drawer body
// is server-rendered (so the R-PP10 contact rule stays
// server-authoritative - phone digits only exist inside tel:/sms:
// href attributes, never in state or props the client can read as
// text). This client wrapper exists only to play the exit
// animation before the URL navigation clears ?card= and the
// drawer unmounts (GOTCHAS.md #10).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

export function PersonCardFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [exiting, setExiting] = useState(false);
  const closingRef = useRef(false);

  const closeHref = (() => {
    const next = new URLSearchParams(sp.toString());
    next.delete("card");
    const s = next.toString();
    return s ? `${pathname}?${s}` : pathname;
  })();

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setExiting(true);
    // Match --sp-slow (320ms) + a small buffer.
    window.setTimeout(() => {
      router.push(closeHref);
    }, 340);
  }, [closeHref, router]);

  // Esc closes the drawer; outside-click closes the drawer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      <div
        className={`kf-pe-backdrop${exiting ? " kf-pe-backdrop--exit" : ""}`}
        onClick={close}
        aria-hidden
      />
      <aside
        className={`kf-pe-drawer${exiting ? " kf-pe-drawer--exit" : ""}`}
        role="dialog"
        aria-label="Person card"
        aria-modal="false"
      >
        {children}
      </aside>
    </>
  );
}

// Close-button client control shown inside the drawer head. Reuses
// the same fade+slide exit so clicks and Escape behave identically.
export function PersonCardCloseButton() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [exiting, setExiting] = useState(false);
  const close = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    const next = new URLSearchParams(sp.toString());
    next.delete("card");
    const s = next.toString();
    window.setTimeout(() => router.push(s ? `${pathname}?${s}` : pathname), 340);
  }, [router, sp, pathname, exiting]);
  return (
    <button type="button" className="kf-pe-iconbtn" aria-label="Close" onClick={close}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

// T2.2.1 (2026-11-12). Phone-only Close in the drawer footer, per
// the render's footer. Same exit animation path as the head-icon
// close + the backdrop + Escape - all four routes clear ?card=
// through the same 340ms setTimeout.
export function PersonCardFooterClose() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [exiting, setExiting] = useState(false);
  const close = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    const next = new URLSearchParams(sp.toString());
    next.delete("card");
    const s = next.toString();
    window.setTimeout(() => router.push(s ? `${pathname}?${s}` : pathname), 340);
  }, [router, sp, pathname, exiting]);
  return (
    <button
      type="button"
      className="kf-btn kf-btn--ghost kf-only-phone"
      onClick={close}
    >
      <span>Close</span>
    </button>
  );
}
