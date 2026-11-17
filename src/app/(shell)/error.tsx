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
  return (
    <div className="kf-error" role="alert">
      <h3 className="kf-error__title">This page did not load</h3>
      <p className="kf-error__body">
        Your data is safe. This is usually a dropped connection. Check it, then try again.
      </p>
      <div>
        <button type="button" className="kf-btn kf-btn--line kf-btn--sm" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </div>
  );
}
