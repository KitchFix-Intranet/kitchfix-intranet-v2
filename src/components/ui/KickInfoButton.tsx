"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

// Icon button rendered inside the identity band's kick row. Opens a popover
// below the band on click AND on focus; closes on Escape and outside click.
// Never hover-only - the content has to be reachable from the keyboard too.

export function KickInfoButton({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="kf-kickinfo" ref={rootRef}>
      <button
        type="button"
        className="kf-kickinfo__btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        title="What is this?"
      >
        <Info size={16} strokeWidth={1.5} />
      </button>
      {open ? (
        <div className="kf-kickinfo__pop" role="dialog" aria-label="About this surface">
          {children}
        </div>
      ) : null}
    </div>
  );
}
