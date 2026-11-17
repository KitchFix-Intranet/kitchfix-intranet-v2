// src/lib/rippling.js (partial move: `isCardAuthorization` only)
//
// The Rippling API client stays in v1. Only the small predicate used
// by the purchasing loader comes across in this train.

// R-148D · Card Authorization classifier. [name] ruling 2026-09-24: a
// swipe hold is not a charge. This helper reads Rippling's own
// `Object Type` field from a report_txns row's `raw` jsonb and returns
// true when the row is a Card Authorization hold. Used by:
//   - scripts/purchasing_rippling_sync.mjs (derive-side holdSeen build)
//   - src/lib/purchasing/loaders.js       (loadCompliance filter)
// Same three-line predicate in both places; extracting it keeps the
// hold classification single-sourced. Object Type is null on report
// rows landed before 2026-07-28; callers decide whether to keep or
// drop those - this helper only answers "is this a hold?" for rows
// that actually carry the field.
export function isCardAuthorization(rawJsonb: any) {
  const objectType = rawJsonb && rawJsonb["Object Type"];
  return objectType === "Card Authorization";
}
