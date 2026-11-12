"use client";

// T4b-1 (2026-11-14). Two-way switch built in the People lane
// (R-PP23) - no native checkbox or radio. Matches the render's
// .kf-pe-seg role="group" with two buttons carrying
// aria-pressed=true/false. Used for:
//   - Separation Type (Voluntary / Involuntary)
//   - Change in title "Will their pay change too?" (Yes / No)
//   - Part-time or full-time direction
//   - Cell phone Frequency (Monthly / Bi-weekly)
//   - Reclassification title + rate switches
//   - Separation Eligible to rehire
//
// Both buttons sit at --sp-floor-chef; pressed = white card with
// shadow, unpressed = transparent navy on sky-tint.

type Option<V extends string> = { value: V; label: string };

export function Switch2<V extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: readonly [Option<V>, Option<V>];
  value: V | null;
  onChange: (next: V) => void;
  ariaLabel: string;
}) {
  return (
    <div className="kf-pe-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value ? "true" : "false"}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
