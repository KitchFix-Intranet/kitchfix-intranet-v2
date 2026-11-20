// Train 2b fix-before-push #8 / section 4.3. Pure.
//
// The finish route and the PATCH route use the same rule for
// sort_order: a whole number of zero or more is used; anything
// else is ignored. On the finish route "ignored" means fall
// back to `nextOrder` so the insert never fails on a bad input
// (a failed insert would then remove the stored file). On the
// PATCH route "ignored" means do not touch sort_order.
//
// Extracted so both routes call the same function and so the
// rule can be tested on its own without a Supabase mock.

export function pickSortOrder(input: unknown, fallback: number): number {
  if (typeof input === "number" && Number.isInteger(input) && input >= 0) return input;
  return fallback;
}
