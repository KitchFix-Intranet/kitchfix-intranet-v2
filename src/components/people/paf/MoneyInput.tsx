"use client";

// Money input. "$" prefix is a presentational span inside a
// bordered box; the actual <input> is a plain text input so we
// can format on blur and never involve the browser's number
// parser (which would coerce "$12.50" to NaN).
//
// Rules:
//   - allow digits + one decimal point while typing
//   - format to two decimals on blur
//   - caller stores the string; downstream helpers parse it

import { useCallback } from "react";

export function MoneyInput({
  id, value, onChange, placeholder = "0.00", ariaInvalid,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaInvalid?: boolean;
}) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Strip anything except digits + one dot. Collapse multiple
    // dots to the first one so paste of "12.34.56" becomes "12.34".
    const raw = e.currentTarget.value;
    let s = raw.replace(/[^\d.]/g, "");
    const firstDot = s.indexOf(".");
    if (firstDot >= 0) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    // Clamp to two decimals.
    if (firstDot >= 0 && s.length - firstDot > 3) s = s.slice(0, firstDot + 3);
    onChange(s);
  }, [onChange]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const s = e.currentTarget.value.trim();
    if (!s) { onChange(""); return; }
    const n = Number(s);
    if (!Number.isFinite(n)) { onChange(""); return; }
    onChange(n.toFixed(2));
  }, [onChange]);

  return (
    <span className="kf-pe-money">
      <span className="kf-pe-money__sign" aria-hidden>$</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={ariaInvalid ? "true" : undefined}
      />
    </span>
  );
}
