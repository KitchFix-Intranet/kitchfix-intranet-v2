"use client";

// Print the current document via the browser print dialog. "PDF" is
// a browser-print option; a dedicated server-side Library PDF is not
// in this train.

import { Printer } from "lucide-react";

export function PrintDocButton() {
  return (
    <button
      type="button"
      className="kf-btn kf-btn--line"
      onClick={() => {
        try {
          window.print();
        } catch {
          // non-fatal
        }
      }}
      aria-label="Print this document"
    >
      <Printer size={16} strokeWidth={1.5} />
      <span>Print</span>
    </button>
  );
}
