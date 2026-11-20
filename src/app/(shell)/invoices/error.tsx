"use client";

// Train 2b correction F5: plain words, no error.message, Retry.

import "@/components/invoices/invoices.css";
import "@/components/invoices/capture.css";

export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="kf-invoices-surface">
      <div className="kf-error" role="alert">
        <h2>This page did not load</h2>
        <p>Try again. If this keeps happening, tell the office.</p>
        <button type="button" className="kf-btn kf-btn--primary" onClick={reset}>
          Retry
        </button>
      </div>
    </div>
  );
}
