"use client";

// /invoices/list error boundary. Plain words. `.kf-error` card.

import "@/components/invoices/invoices.css";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="kf-invoices-surface">
      <div className="kf-error" role="alert">
        <h3>Something is off</h3>
        <p>
          The invoices page could not load. If this keeps happening, tell the
          office so we can take a look.
        </p>
        <button className="kf-btn kf-btn--primary" type="button" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </div>
  );
}
