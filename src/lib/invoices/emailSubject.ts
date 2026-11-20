// Pure. The subject accounting keys bills from.
//
// Shape (prompt §6):
//   [KitchFix] | <site> | <vendor> | #<number> | $<total>
//
// A credit inserts `CREDIT | ` after `[KitchFix] | `:
//   [KitchFix] | CREDIT | <site> | <vendor> | #<number> | $<total>
//
// The total is shown positive with two decimals and thousands
// commas. In test mode the whole subject is prefixed with
// `[TEST] ` (prompt §4; a space before [KitchFix]).

import type { RowMode } from "./recipients";

export interface SubjectInput {
  mode: RowMode;
  kind: "invoice" | "credit";
  site: string;
  vendor: string;
  number: string;
  total: number;              // the stored total (credit is negative); the subject shows positive
}

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function formatMoney(nAbs: number): string {
  const cents = Math.round(nAbs * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  const withCommas = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}.${pad2(frac)}`;
}

export function buildSubject(input: SubjectInput): string {
  const testPrefix = input.mode === "test" ? "[TEST] " : "";
  const kindPrefix = input.kind === "credit" ? "CREDIT | " : "";
  const total = formatMoney(Math.abs(input.total));
  return `${testPrefix}[KitchFix] | ${kindPrefix}${input.site} | ${input.vendor} | #${input.number} | ${total}`;
}
