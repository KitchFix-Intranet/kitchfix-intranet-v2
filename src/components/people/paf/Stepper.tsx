"use client";

// T4a.1 (2026-11-14). Four word pills on desktop (render's
// .kf-pe-words). On phone (<=640) the CSS collapses the li's into a
// four-segment thin bar plus one line of text ("Step N of 4 ·
// <name>") via the ol's data-step attribute + ::after rule.
//
// Replaces T4a's dotted-timeline .kf-pe-stepper.

const STEPS = ["Who", "What", "Details", "Check"] as const;

export function Stepper({ step }: { step: 0 | 1 | 2 | 3 }) {
  const label = STEPS[step] ?? "Who";
  const dataStep = `Step ${step + 1} of ${STEPS.length} · ${label}`;
  return (
    <ol className="kf-pe-words" aria-label="Progress" data-step={dataStep}>
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={i < step ? "is-done" : i === step ? "is-current" : ""}
          aria-current={i === step ? "step" : undefined}
        >
          {s}
        </li>
      ))}
    </ol>
  );
}
