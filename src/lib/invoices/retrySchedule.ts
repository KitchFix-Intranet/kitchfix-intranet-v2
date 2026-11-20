// Invoices V2 - pure retry schedule.
//
// Prompt §5: 10 minutes for the first three tries, then 30
// minutes, then hourly. After 24 hours from the first try the
// row gives up.
//
// Inputs:
//   firstTriedAt - the first attempt's time (ISO on the row)
//   attemptsSoFar - how many tries have already happened,
//                   counting the one that just failed
//   now          - the current time
//
// Output:
//   { kind: "schedule", nextAttemptAt }  the next due time;
//   { kind: "gave_up" }                  a full day has passed.
//
// The decision is: compute the candidate next time (now + wait),
// and if that is more than 24 hours after firstTriedAt, give
// up. We cap on `now` not on `firstTriedAt + sum(waits)` so a
// retry that fires late does not keep the row alive past the
// 24 hour mark.

export const GAVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

const TEN_MIN = 10 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export function waitAfterAttempt(attemptsSoFar: number): number {
  // After the 1st, 2nd and 3rd failures: 10 minutes.
  // After the 4th: 30 minutes.
  // After the 5th and on: hourly.
  if (attemptsSoFar <= 0) return TEN_MIN;
  if (attemptsSoFar <= 3) return TEN_MIN;
  if (attemptsSoFar === 4) return THIRTY_MIN;
  return ONE_HOUR;
}

export type RetryDecision =
  | { kind: "schedule"; nextAttemptAt: Date }
  | { kind: "gave_up" };

export function decideRetry(
  firstTriedAt: Date,
  attemptsSoFar: number,
  now: Date,
): RetryDecision {
  const wait = waitAfterAttempt(attemptsSoFar);
  const nextAttemptAt = new Date(now.getTime() + wait);
  // 24 hour cap: measured from the first try. If the next
  // attempt would land after that cap, give up.
  if (nextAttemptAt.getTime() - firstTriedAt.getTime() > GAVE_UP_AFTER_MS) {
    return { kind: "gave_up" };
  }
  return { kind: "schedule", nextAttemptAt };
}
