// N0b: countability lives in the DATABASE as the view
// `pr_countable_observations`, applied in migrations 0012 (view
// definition) and 0013 (de-correlated form for performance). This
// module is the one place Node code names that source; every
// aggregate query over observations reads FROM this constant.
//
// Why a view and not a column:
//
//   invoice_submissions.status = 'corrected' is written by a system
//   outside this codebase (verified 2026-11-05: `grep` for
//   `invoice_submissions` in src/ returns only reads). A stored flag
//   maintained by this app cannot be guaranteed to fire when the
//   write comes from a sibling service, and a one-time backfill
//   would drift at ~5 new corrected submissions per month (12 in
//   the last 90 days). The view is computed from current state on
//   every read, so it cannot go stale and it cannot be clobbered.
//
// Semantics of the view (0012/0013):
//
//   excluded (NOT in the view):
//     - excluded_reason IS NOT NULL
//       Already excluded on other grounds - 'not_food', 'needs_review'
//       (Kevin's curation decisions) or any future reason.
//     - the observation's submission has status = 'deleted'
//     - the observation's submission has status = 'corrected' AND
//       another submission exists for the same invoice_number whose
//       status is neither 'corrected' nor 'deleted' (= superseded by
//       a live replacement)
//
//   included (IN the view):
//     - everything else, including:
//       * orphans (line_id resolves to no submission) - 217 obs /
//         $28,818 on 2026-11-05, pending Kevin's ruling
//       * abandoned corrections (a 'corrected' submission that is the
//         only copy of its invoice) - 262 obs / $22,193, pending
//         Kevin's ruling
//
// Measured 2026-11-05 against the live table:
//
//   26,230 countable before the view     -> 25,639 after
//   591 observations / 503 items / $63,171.17 of double-counting
//   removed. Full-catalog aggregate 1.27 s; per-item 19 ms.
//
// Every aggregate PostgREST read reads `.from(COUNTABLE_OBSERVATIONS_VIEW)`.
// `grep -n 'from("pr_price_observations")' src/` should return ONLY
// the intake upsert (writes can't go through a view); every other
// hit is a bug. `grep -n COUNTABLE_OBSERVATIONS_VIEW src/` lists
// every aggregate site at once.

export const COUNTABLE_OBSERVATIONS_VIEW = "pr_countable_observations";
