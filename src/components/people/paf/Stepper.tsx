"use client";

// Four-step strip: Who · What · Details · Check.
// `step` is the active index (0..3). Steps before the active one
// render `.is-done` (filled navy dot); the active one renders
// `.is-current` (ringed dot). Mirrors the render's .kf-pe-stepper.

const STEPS = ["Who", "What", "Details", "Check"] as const;

export function Stepper({ step }: { step: 0 | 1 | 2 | 3 }) {
  return (
    <ol className="kf-pe-stepper" aria-label="Progress">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={i < step ? "is-done" : i === step ? "is-current" : ""}
          aria-current={i === step ? "step" : undefined}
        >
          <span className="kf-pe-step__dot" aria-hidden />
          <span className="kf-pe-step__label">{label}</span>
        </li>
      ))}
    </ol>
  );
}
