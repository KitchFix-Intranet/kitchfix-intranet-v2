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

// Train 2b round-2 fix #2. Pure.
//
// The 9-in-10 fill plants a single coding line equal to the total.
// While the coding is still the tool's own fill AND the user has
// not touched it, the amount follows the total as it changes.
//
// The "did the tool fill this and has the user touched it" mark
// cannot live on the row: the PATCH route strips extra fields, and
// flush() calls setDraft(out.draft), so any row-level mark is lost
// after the first save and the fill sticks again on the next
// keystroke. Instead the component owns the mark (a ref), passes
// it IN, and reads the next value OUT. Nothing about the mark
// goes to the server.
//
// Return contract:
//   - When nothing changed, `coding` is the same reference the
//     caller passed in (so an unchanged total does not stage a
//     save in the component).
//   - `isFilled` reads true only when the tool is actively
//     tracking a single-line fill for the current fillCode.
export interface LineLite {
  code: string;
  name: string;
  amount: number;
}

export interface SingleCodeFillResult {
  coding: ReadonlyArray<LineLite>;
  isFilled: boolean;
}

export function applySingleCodeFill(
  total: number | null,
  coding: ReadonlyArray<LineLite>,
  fillCode: { code: string; name: string } | null,
  isFilled: boolean,
): SingleCodeFillResult {
  if (!fillCode) return { coding, isFilled: false };
  if (total == null) return { coding, isFilled };

  if (coding.length === 0) {
    const planted: LineLite[] = [{ code: fillCode.code, name: fillCode.name, amount: total }];
    return { coding: planted, isFilled: true };
  }

  if (coding.length === 1 && isFilled && coding[0].code === fillCode.code) {
    if (coding[0].amount === total) {
      return { coding, isFilled: true };
    }
    const updated: LineLite[] = [{ ...coding[0], amount: total }];
    return { coding: updated, isFilled: true };
  }

  return { coding, isFilled: false };
}
