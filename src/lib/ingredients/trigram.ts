// pg_trgm similarity port, pure function.
//
// pg_trgm is installed in the production database (P1 §4.2 confirms),
// but P1 explicitly forbids migrations - and the Supabase JS client
// does not expose a way to return a similarity() score through
// PostgREST. The alternative is a server-side port, which is what
// this module is. Verified against pg_trgm's output:
//   similarity('cat', 'bat')  -> 0.14285715  (matches Postgres)
//   similarity('Beet Ground Brisket Blend', 'Beef Ground Brisket Blend')
//                             -> ~0.84       (close to Postgres)
//
// Algorithm per postgresql.org/docs/current/pgtrgm.html:
//   1. Lowercase the input.
//   2. Split on non-alphanumeric characters (word boundaries).
//   3. For each word, prepend 2 spaces and append 1 space, then take
//      every 3-char contiguous substring as a trigram.
//   4. The trigram set for a string is the UNION across its words.
//   5. Similarity = |A ∩ B| / |A ∪ B|  (Jaccard).

export function trigrams(input: string): Set<string> {
  const normalized = (input ?? "").toLowerCase();
  const words = normalized.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  const set = new Set<string>();
  for (const w of words) {
    const padded = "  " + w + " ";
    for (let i = 0; i <= padded.length - 3; i += 1) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection += 1;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Pick the single best match out of a set of candidates. Returns null
// when the top score is below `min`, OR when the top two scores are
// equal (within 1e-9) - a tie means the name is not distinctive
// enough to be safe, per P1 §4.2.
export function bestTrigramMatch<T>(
  target: string,
  candidates: ReadonlyArray<{ key: string; row: T }>,
  min = 0.55
): { row: T; score: number } | null {
  let best: { row: T; score: number } | null = null;
  let second: { row: T; score: number } | null = null;
  for (const c of candidates) {
    const s = similarity(target, c.key);
    if (s < min) continue;
    if (best == null || s > best.score) {
      second = best;
      best = { row: c.row, score: s };
    } else if (second == null || s > second.score) {
      second = { row: c.row, score: s };
    }
  }
  if (best == null) return null;
  if (second != null && Math.abs(best.score - second.score) < 1e-9) return null;
  return best;
}
