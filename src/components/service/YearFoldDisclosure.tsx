// The phone-only "Show the year" / "Hide the year" fold. A small
// client component that wraps the server-rendered year body as
// children, so the server year tree never has to send a function
// into a client child.

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export function YearFoldDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="kf-sc-yearsec__fold kf-sc-only-narrow"
        aria-expanded={open}
        aria-controls="kf-sc-yearsec-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? "Hide the year" : "Show the year"}</span>
        {open ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
      </button>
      <div id="kf-sc-yearsec-body" className={`kf-sc-yearsec__body${open ? " is-open" : ""}`}>
        {children}
      </div>
    </>
  );
}
