// "Usual codes" for a site+vendor pair. Pure.
//
// Input: the last 10 invoices that count (§5 list filter) for a
// (site, vendor) pair, each with a gl_breakdown array of
// { code, name, amount }.
//
// Output:
//   - `codes`: the set of distinct codes that appeared on any of the
//     last 10. Each row carries how many of the last 10 it appeared
//     on, and its best-known `name` (the most recent name seen).
//     Used by the UI to show the one-tap "usual codes" row.
//   - `singleCodeFill`: when there are at least 10 invoices and one
//     single code took the whole amount on at least 9 of them, the
//     code to auto-fill when the total is typed. `null` otherwise.
//
// The "whole amount" rule: a single invoice counts for the fill only
// when its gl_breakdown has exactly one line AND that line's amount
// equals the invoice total to the cent. Multi-line or partial lines
// do not count even if one of the lines is the usual code.

import type { GlLine } from "./types";
import { toCents } from "./addUp";

export interface PastInvoiceLite {
  total_amount: number | null;
  gl_breakdown: GlLine[];
}

export interface UsualCode {
  code: string;
  name: string;
  appearances: number; // of the last 10 (sample size may be <10)
}

export interface UsualCodesResult {
  codes: UsualCode[];
  singleCodeFill: UsualCode | null;
  sampleSize: number;              // number of past invoices considered (<=10)
}

export function computeUsualCodes(past: readonly PastInvoiceLite[]): UsualCodesResult {
  const sample = past.slice(0, 10);
  const map = new Map<string, { name: string; appearances: number }>();

  // Track "whole-amount single-code" hits separately.
  const wholeAmountHits = new Map<string, { name: string; count: number }>();

  for (const inv of sample) {
    const linesByCode = new Map<string, GlLine>();
    for (const l of inv.gl_breakdown ?? []) {
      // If a bill has two rows with the same code, merge them for
      // appearance-counting purposes. "Appeared on this invoice."
      linesByCode.set(l.code, { code: l.code, name: l.name, amount: (linesByCode.get(l.code)?.amount ?? 0) + (l.amount || 0) });
    }
    for (const l of linesByCode.values()) {
      const entry = map.get(l.code) ?? { name: l.name, appearances: 0 };
      entry.appearances += 1;
      entry.name = l.name; // keep most recent name
      map.set(l.code, entry);
    }
    // whole-amount: one distinct code AND its summed amount equals the total to the cent
    const total = inv.total_amount;
    if (total != null && linesByCode.size === 1) {
      const only = Array.from(linesByCode.values())[0];
      if (toCents(only.amount) === toCents(total)) {
        const w = wholeAmountHits.get(only.code) ?? { name: only.name, count: 0 };
        w.count += 1;
        w.name = only.name;
        wholeAmountHits.set(only.code, w);
      }
    }
  }

  const codes: UsualCode[] = Array.from(map.entries())
    .map(([code, v]) => ({ code, name: v.name, appearances: v.appearances }))
    .sort((a, b) => b.appearances - a.appearances || a.code.localeCompare(b.code));

  let singleCodeFill: UsualCode | null = null;
  if (sample.length >= 10) {
    let best: { code: string; name: string; count: number } | null = null;
    for (const [code, v] of wholeAmountHits.entries()) {
      if (v.count >= 9 && (best === null || v.count > best.count)) {
        best = { code, name: v.name, count: v.count };
      }
    }
    if (best) {
      singleCodeFill = { code: best.code, name: best.name, appearances: best.count };
    }
  }

  return { codes, singleCodeFill, sampleSize: sample.length };
}

// Train 2b fix-before-push #4. Pure.
//
// The 9-in-10 fill plants a single coding line equal to the total.
// Before this fix the fill only fired once (when the coding was
// empty), so a user typing "100" saw "1", "10", "100" each stage:
// the first keystroke filled the code with "1" and then stuck
// there while the total grew. Now, while the coding is still the
// tool's own fill (one line with `auto: true` and the fillCode's
// code), the amount follows the total. Once the user edits the
// code or the amount, `auto` flips off and the tool stops writing.
//
// Inputs: the parsed total (or null), the current coding, and
// the vendor's singleCodeFill (or null). Returns the next coding.
export function applySingleCodeFill(
  total: number | null,
  coding: ReadonlyArray<{ code: string; name: string; amount: number; auto?: boolean }>,
  fillCode: { code: string; name: string } | null,
): Array<{ code: string; name: string; amount: number; auto?: boolean }> {
  if (!fillCode) return coding.slice();
  if (total == null) return coding.slice();

  // No coding yet - plant the auto-fill line.
  if (coding.length === 0) {
    return [{ code: fillCode.code, name: fillCode.name, amount: total, auto: true }];
  }

  // Coding is one line, it's the tool's own auto-fill for the same
  // code: update the amount to match the new total.
  if (coding.length === 1) {
    const only = coding[0];
    if (only.auto && only.code === fillCode.code) {
      if (only.amount === total) return coding.slice();
      return [{ ...only, amount: total, auto: true }];
    }
  }

  // User-edited coding - leave it alone.
  return coding.slice();
}
