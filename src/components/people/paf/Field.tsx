"use client";

// T4a form primitive. Label + hint + optional error, scoped to
// the PAF form so other screens are not affected by Field
// styling. Required is the default; only optional fields are
// marked with "Optional" in the hint slot.

import type React from "react";

export function Field({
  label,
  htmlFor,
  hint,
  optional,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  optional?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  const errId = error && htmlFor ? `${htmlFor}-err` : undefined;
  const hintId = hint && htmlFor ? `${htmlFor}-hint` : undefined;
  return (
    <label className={`kf-pe-field${error ? " is-missing" : ""}`} htmlFor={htmlFor}>
      <span>
        {label}
        {optional ? <small className="kf-pe-field__hint">Optional</small> : null}
      </span>
      {hint ? <span id={hintId} className="kf-pe-field__hint2">{hint}</span> : null}
      {children}
      {error ? <span id={errId} role="alert" className="kf-pe-field__err">{error}</span> : null}
    </label>
  );
}
