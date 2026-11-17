// Account key <-> URL slug for the invoices lane. Round-trips the
// nine site keys that carry invoices today, plus the two sites in
// scope without invoices (TXR variants vary only in trailing letter;
// slug keeps them distinct). The function is pure and allocates
// nothing.
//
// Rule: lowercase, then " - " becomes "-".
//   "TBR - FL"     <-> "tbr-fl"
//   "TXR - TX - H" <-> "txr-tx-h"
//
// A lane-local copy of the identical rule in src/lib/sc/calendar/slug.ts.
// Each lane holds its own so one lane never reaches across for a
// routing helper; a change here does not touch SC.

export function accountKeyToSlug(accountKey: string): string {
  return accountKey.toLowerCase().replace(/\s-\s/g, "-");
}

export function slugToAccountKey(
  slug: string,
  inScopeKeys: readonly string[],
): string | null {
  const want = slug.toLowerCase();
  for (const key of inScopeKeys) {
    if (accountKeyToSlug(key) === want) return key;
  }
  return null;
}
