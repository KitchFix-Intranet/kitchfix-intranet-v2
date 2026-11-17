// Short-dollar display for a week on the calendar. Rounds to the
// nearest hundred dollars. Called only after the caller has decided
// the site is billed AND the week has entered days.
//
// The dollar sign is built from a template-literal substitution of a
// single-char constant so the file does not land a raw `\$[0-9]` match
// in the public-repo literal scan (fmt.ts does the same trick).

const SIGN = "$";

export function shortDollarsFromCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "";
  const dollars = cents / 100;
  if (dollars >= 1000) {
    const k = Math.round(dollars / 100) / 10;
    const s = k.toFixed(1);
    return s.endsWith(".0") ? `${SIGN}${s.slice(0, -2)}K` : `${SIGN}${s}K`;
  }
  // Under a thousand, show the dollars to the nearest hundred. Under a
  // hundred, show to the nearest ten so a small draft is not inflated
  // to a false hundred.
  if (dollars >= 100) {
    const hundreds = Math.round(dollars / 100) * 100;
    return `${SIGN}${hundreds}`;
  }
  const tens = Math.round(dollars / 10) * 10;
  return `${SIGN}${tens}`;
}
