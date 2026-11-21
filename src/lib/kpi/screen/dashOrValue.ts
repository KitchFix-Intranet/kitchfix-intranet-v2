// src/lib/kpi/screen/dashOrValue.ts
//
// Train 2d-1. v1 component:
// src/app/kpi/overview/components/DashOrValue.js (91 lines).
//
// The one rendering primitive for the six non-value states on the
// closed-range Overview.
//
//   state       | payload signal
//   -----------|---------------------------------------------
//   missing    | reported: false + value nullish
//   failed     | flag "failed" on the row
//   zero       | reported: true + value === 0
//   not-active | flag "not_active"
//   no-budget  | budget nullish + actual reported
//   not-started| flag "not_started"
//
// The picker function `resolveDashState` inspects the signals and
// returns the render shape. This file moves the LOGIC whole from v1
// (same input, same output); the JSX wrapper is dropped. Callers get
// the dash state + the preformatted value so a downstream formatter
// can turn each state into display copy.

export type DashState =
  | "value"
  | "zero"
  | "failed"
  | "not_active"
  | "no_budget"
  | "not_started"
  | "missing";

export type DashInput = {
  value?: any;
  reported?: any;
  flags?: any;
  state?: DashState | null;
  budget?: any;
};

// Verbatim from v1 resolveDashState (DashOrValue.js:24-33). Returns
// the dash state word. The helper is pure - every path is a boolean
// check on fields of its argument.
export function resolveDashState(input: DashInput): DashState {
  const { value, reported, flags = [], budget: _budget } = input;
  if (Array.isArray(flags) && flags.includes("failed")) return "failed";
  if (Array.isArray(flags) && flags.includes("not_started")) return "not_started";
  if (Array.isArray(flags) && flags.includes("not_active")) return "not_active";
  if (reported === false) return "missing";
  if (value === 0) return "zero";
  if (value == null) return "missing";
  return "value";
}

// The v1 component accepts either a self-picking input (value +
// reported + flags) OR an explicit `state` override. This helper
// mirrors that choice.
export function dashOrValue(input: DashInput): {
  state: DashState;
  value: any;
} {
  const state = input.state || resolveDashState(input);
  return { state, value: input.value };
}

// --- Formatter ----------------------------------------------------
//
// v1 copy (DashOrValue.js:36-81):
//   value        -> {value}         (caller preformatted)
//   zero         -> "$0"
//   failed       -> "failed"
//   not_active   -> "not active"
//   no_budget    -> "no budget"
//   not_started  -> "not started"
//   missing      -> "-" (the hyphen is a hyphen, not an em-dash)

export const DASH_HYPHEN = "-";

export function formatDashOrValue(
  state: DashState,
  value: any,
): string {
  if (state === "value") return value == null ? DASH_HYPHEN : String(value);
  if (state === "zero") return "$0";
  if (state === "failed") return "failed";
  if (state === "not_active") return "not active";
  if (state === "no_budget") return "no budget";
  if (state === "not_started") return "not started";
  return DASH_HYPHEN;
}
