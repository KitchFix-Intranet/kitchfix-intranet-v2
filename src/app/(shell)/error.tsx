"use client";

import { useEffect } from "react";

export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (typeof console !== "undefined") console.error(error);
  }, [error]);
  const message = error.message || "Something went wrong.";
  return (
    <div className="kf-error" role="alert">
      <h3 className="kf-error__title">We couldn&rsquo;t load this page</h3>
      <p className="kf-error__body">{message}</p>
      <div>
        <button type="button" className="kf-btn kf-btn--line kf-btn--sm" onClick={() => reset()}>
          Retry
        </button>
      </div>
    </div>
  );
}
