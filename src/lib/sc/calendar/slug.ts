// Account key <-> URL slug. The seven calendar accounts all round-trip
// cleanly; the function throws on an unseen key to make a bad caller loud.
//
//   "TBR - FL" <-> "tbr-fl"

export function accountKeyToSlug(accountKey: string): string {
  return accountKey.toLowerCase().replace(/\s-\s/g, "-");
}

export function slugToAccountKey(slug: string, calendarAccountKeys: readonly string[]): string | null {
  const want = slug.toLowerCase();
  for (const key of calendarAccountKeys) {
    if (accountKeyToSlug(key) === want) return key;
  }
  return null;
}
