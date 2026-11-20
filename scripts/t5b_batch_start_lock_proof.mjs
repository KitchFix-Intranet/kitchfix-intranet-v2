// T5b ruling 7 proof: a batch run is in progress when the newest
// ai_match_run_started row is younger than 330 seconds AND no
// ai_match_run row with at >= that start has been written.
//
// The matcher is NEVER started here. The predicate is pulled from
// src/lib/matcher/lock.ts (pure function, no imports) so the proof
// does not stand up any Supabase or Anthropic client.
//
// Run: node --import tsx scripts/t5b_batch_start_lock_proof.mjs

import { isBatchInProgress, BATCH_FRESH_MS } from "../src/lib/matcher/lock.ts";

let pass = 0;
let fail = 0;
function ok(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`ok   ${label} (got ${g}, want ${w})`);
  } else {
    fail++;
    console.log(`FAIL ${label} (got ${g}, want ${w})`);
  }
}

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();

// 1. No events ever: not in progress.
ok("empty events: not in progress", isBatchInProgress(null, null, NOW), false);

// 2. A started row 10 seconds ago, no end row yet: in progress.
ok(
  "fresh start, no end: in progress",
  isBatchInProgress(iso(-10_000), null, NOW),
  true,
);

// 3. A started row 329 seconds ago, no end row yet: still in progress.
ok(
  "start at edge of window, no end: in progress",
  isBatchInProgress(iso(-(BATCH_FRESH_MS - 1_000)), null, NOW),
  true,
);

// 4. A started row 330 seconds ago (window boundary), no end row: not
//    in progress (stale start, probably a dead cron pull).
ok(
  "start at exact window: not in progress",
  isBatchInProgress(iso(-BATCH_FRESH_MS), null, NOW),
  false,
);

// 5. A started row way back, no end row: not in progress.
ok(
  "ancient start, no end: not in progress",
  isBatchInProgress(iso(-60 * 60 * 1000), null, NOW),
  false,
);

// 6. A started row 50 s ago AND an end row 20 s ago (after the start):
//    not in progress.
ok(
  "fresh start AND fresh end after it: not in progress",
  isBatchInProgress(iso(-50_000), iso(-20_000), NOW),
  false,
);

// 7. A started row 50 s ago AND an end row 100 s ago (BEFORE the
//    start, i.e. this end row ended an earlier run): in progress.
ok(
  "fresh start, end before it: in progress",
  isBatchInProgress(iso(-50_000), iso(-100_000), NOW),
  true,
);

// 8. A started row 50 s ago AND an end row 50 s ago (same ms): not
//    in progress (end >= start, i.e. the run finished).
ok(
  "start equals end: not in progress",
  isBatchInProgress(iso(-50_000), iso(-50_000), NOW),
  false,
);

// 9. Malformed start timestamp: not in progress (never block on a
//    row that cannot be parsed).
ok(
  "malformed start: not in progress",
  isBatchInProgress("not a date", null, NOW),
  false,
);

// 10. Malformed end timestamp with a fresh start: treat as "no valid
//     end", so in progress (fail safe for the user: the UI says "a
//     run is in progress" rather than letting a second run slip
//     through on a garbled end row).
ok(
  "malformed end: in progress",
  isBatchInProgress(iso(-10_000), "garbled", NOW),
  true,
);

console.log("");
console.log(`T5b lock proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
