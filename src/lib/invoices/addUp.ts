// "Adds up" check for Capture. Pure.
//
// Takes a total and a list of GL lines (code, name, amount) and
// returns whether the sum of line amounts equals the total to the
// cent. Works in integer cents to avoid floating-point drift.
//
// "Equals to the cent" per §6: `|sum - total| < 0.005` (half a cent).

import type { GlLineDraft } from "./types";

export function toCents(n: number): number {
  return Math.round(n * 100);
}

export function sumGlCents(lines: readonly GlLineDraft[]): number {
  let sum = 0;
  for (const l of lines) sum += toCents(l.amount || 0);
  return sum;
}

export function leftToCode(total: number | null, lines: readonly GlLineDraft[]): number {
  if (total == null) return 0;
  const want = toCents(total);
  const have = sumGlCents(lines);
  return (want - have) / 100;
}

// Equal to the cent: identical integer cents.
export function addsUp(total: number | null, lines: readonly GlLineDraft[]): boolean {
  if (total == null) return false;
  return toCents(total) === sumGlCents(lines);
}
