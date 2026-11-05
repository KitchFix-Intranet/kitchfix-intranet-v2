// N0: the canonical predicate for "this observation counts toward
// pr_vendor_items.lines / .usd / .lines_12m / .usd_12m" and any UI
// read that aggregates observations.
//
// RULE: an observation is COUNTABLE when `excluded_reason IS NULL`.
//
// The /api/admin/observation-countability route populates
// `excluded_reason` on observations that should not count. "Non-null
// means exclude" is the forward-compatible contract - new exclusion
// reasons can be added without changing the filter here.
//
// Known exclusion values:
//
//   'superseded_submission'
//     The observation's line belongs to an invoice_submission with
//     status='corrected' that has a LIVE replacement for the same
//     invoice_number (another submission with status neither
//     'corrected' nor 'deleted'). Measured 2026-11-05 after
//     reconciling against actual excluded_reason state: 591
//     currently-countable observations / 503 items / $63,171.17 -
//     the largest data-accuracy defect in the stockpot workstream,
//     and it predates every other patch. Another 120 superseded
//     observations already carry a non-null excluded_reason
//     (`not_food` or `needs_review` - Kevin's curation decisions);
//     the N0a route never touches those.
//
//   'deleted_submission'
//     Submission's status is 'deleted'. All five deleted observations
//     on 2026-11-05 already carried a reason, so writing this label
//     moved zero dollars on the first run. The rule stays because it
//     is correct; movement appears the first time a submission is
//     deleted without prior exclusion.
//
// A 'corrected' submission that is the ONLY copy of its invoice is
// NOT superseded. The correction was started and never completed;
// those observations STAY countable. 335 observations / $25,870 as
// of 2026-11-05, left alone pending a separate ruling.
//
// Orphan observations (line_id resolves to no submission) are
// REPORT-ONLY. They may be real spend with a broken link; do not
// exclude without a Kevin ruling. 260 observations / $30,947.
//
// Every PostgREST aggregate read over pr_price_observations MUST
// apply this filter. If a counter is derived from observations
// without it the counter DOUBLE COUNTS the superseded set.
// `grep applyCountableFilter src/` lists every aggregate site at
// once - make sure any new aggregate call site uses this helper
// and is grepped.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const COUNTABILITY_PREDICATE_SQL = "excluded_reason IS NULL";

export const COUNTABILITY_PREDICATE_HUMAN =
  "excluded_reason IS NULL (see src/lib/ingredients/countability.ts)";

// Applies the standard filter to a PostgREST query builder in place.
// Usage:
//   const q = client.from("pr_price_observations").select("...");
//   const { data } = await applyCountableFilter(q).eq(...);
// The helper is intentionally generic - PostgREST builder types shift
// slightly across @supabase/supabase-js versions, so we accept any
// builder and return the same shape.
export function applyCountableFilter<T>(q: T): T {
  return (q as any).is("excluded_reason", null) as T;
}
