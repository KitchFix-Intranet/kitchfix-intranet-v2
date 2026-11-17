// Exact-cents USD formatter for the invoices lane.
//
// src/lib/fmt.ts rounds (fmtUsd compresses to $K / $M, fmtUsdLong
// rounds to whole dollars). Invoice totals need the cents: a $318.75
// invoice must render as $318.75, not $319. This file holds one
// lane-local formatter; the PR body lists it as a candidate for
// promoting into src/lib/fmt.ts once a second lane needs cents.
//
// Credits are stored negative on all 160 credit rows in the DB;
// fmtUsdExact(-45.12) returns "-$45.12". Callers prepend the word
// "Credit" without adding a second minus.

const NUM_WITH_CENTS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtUsdExact(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${NUM_WITH_CENTS.format(abs)}`;
}
