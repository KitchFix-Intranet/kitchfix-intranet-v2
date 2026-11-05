// N0b (+0015 correction): countability is split between the view
// pr_countable_observations and this module.
//
//   STRUCTURE lives in the view.
//     Migrations 0012 / 0013 / 0015 compute the view from current
//     state on every read. It excludes:
//       - submissions with status = 'deleted'
//       - submissions with status = 'corrected' whose siblings include
//         a non-corrected, non-deleted copy (= superseded duplicate),
//         UNLESS the observation is the item's only surviving
//         evidence (survivor rule, 0015 - 127 food items / $13,975
//         would otherwise show at zero, and they are merge candidates
//         not exclusion candidates)
//
//   POLICY lives in each consumer.
//     0015 explicitly does NOT filter excluded_reason, because the
//     stored counters on pr_vendor_items deliberately include
//     `needs_review` spend (measured: 246 of 260 food items with
//     excluded observations carry stored counts that match the
//     all-observations count, not the filtered one). Baking
//     excluded_reason IS NULL into the view would silently drop
//     needs_review spend from 246 items on the next recompute, and
//     Kevin's standing "I don't want things that are not food in
//     the stockpot" rule would put not_food rows back in the review
//     surfaces with no way for consumers to opt out.
//
// So every aggregate site reads FROM the view AND applies this
// module's `applyCountableFilter` helper on top. The one documented
// exception is the live recount in /api/admin/observation-countability
// which reads the view WITHOUT the filter so the recomputed counter
// matches the stored shape (otherwise the recount would drop
// needs_review spend for every item it touches).
//
// `grep -n 'from("pr_price_observations")' src/` should return only
// the intake upsert and the FK-lookup sites in rescan-apply; every
// aggregate uses the view.
// `grep -n COUNTABLE_OBSERVATIONS_VIEW src/` lists every aggregate
// site at once. `grep -n applyCountableFilter src/` lists every
// site that applies policy on top - which is every aggregate site
// EXCEPT the recount.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const COUNTABLE_OBSERVATIONS_VIEW = "pr_countable_observations";

// Applies the excluded_reason IS NULL policy filter to a PostgREST
// query builder in place. Usage:
//   const q = client.from(COUNTABLE_OBSERVATIONS_VIEW).select("...");
//   const { data } = await applyCountableFilter(q).eq(...);
// The helper is intentionally generic - PostgREST builder types
// shift slightly across @supabase/supabase-js versions.
export function applyCountableFilter<T>(q: T): T {
  return (q as any).is("excluded_reason", null) as T;
}
