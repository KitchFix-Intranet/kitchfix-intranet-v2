"use client";

// T4b-1 (2026-11-14). Pick-one chips (render's
// .kf-pe-chips.kf-pe-chips--wrap with .kf-pe-chip buttons), used
// on the Separation Reason row (options shift by Type). Buttons
// carry aria-pressed per the render.

type Option = { value: string; label: string };

export function PickOne({
  options, value, onChange, ariaLabel,
}: {
  options: readonly Option[];
  value: string | null;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="kf-pe-chips kf-pe-chips--wrap" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="kf-pe-chip"
          aria-pressed={value === opt.value ? "true" : "false"}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
