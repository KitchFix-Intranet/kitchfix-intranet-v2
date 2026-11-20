// T5b ruling 7: one predicate decides whether a matcher run is in
// progress. Shared between loadReview (so the batch control knows to
// draw its running/refused state) and /api/review/batch-start (so a
// second press is refused). The check reads two pr_events rows: the
// newest `ai_match_run_started` and the newest `ai_match_run`. A
// start row is a lock only when (a) it is younger than the freshness
// window and (b) no `ai_match_run` row followed it. Dead starts from
// old cron pulls (no end row ever written) never block.
//
// The window is matcher.maxDuration + one 30 s grace. /api/match
// exports maxDuration = 300; this file holds 330 s.
//
// Pure function. No imports, no side effects. The proof script
// scripts/t5b_batch_start_lock_proof.mjs exercises every branch.

export const BATCH_FRESH_MS = 330_000 as const;

export function isBatchInProgress(
  startAt: string | null,
  endAt: string | null,
  nowMs: number,
): boolean {
  if (!startAt) return false;
  const startMs = Date.parse(startAt);
  if (!Number.isFinite(startMs)) return false;
  if (nowMs - startMs >= BATCH_FRESH_MS) return false;
  if (!endAt) return true;
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(endMs)) return true;
  return endMs < startMs;
}
