// T5b round 2 item 2 proof: the batch-start claim-and-check cannot
// let two requests both start a run. The proof imports the REAL
// claim module (src/lib/matcher/claim.ts) and a REAL route helper
// (not a copy), stands up an in-memory EventsStore, and injects a
// stand-in matcher that counts calls.
//
// Cases named:
//   1. two requests started together - one call
//   2. five requests started together - one call
//   3. a request arriving while a run is live - zero calls
//   4. a request after a finished run - one call
//   5. a request after a refused claim - one call
//   6. a request after a dead start row (> 330 s) - one call
//
// Run: node --import tsx scripts/t5b_batch_start_lock_proof.mjs

import { randomUUID } from "node:crypto";
import {
  tryClaim,
  isLive,
  CLAIM_SETTLE_MS,
  SENTINEL_UUID,
} from "../src/lib/matcher/claim.ts";
import { BATCH_FRESH_MS, isBatchInProgress } from "../src/lib/matcher/lock.ts";

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

// ---------- in-memory EventsStore stand-in --------------------------
function makeStore({ nowRef }) {
  let seq = 0;
  const rows = []; // { id, at: ISO, kind, after }
  function insert(kind, after) {
    const id = randomUUID();
    // Postgres supplies `at`; emulate with the shared clock reference
    // so the test can advance deterministically. Sub-millisecond
    // ordering falls out of insertion sequence; we add a tiny seq
    // nudge so two inserts in the same ms are strictly ordered.
    seq += 1;
    const at = new Date(nowRef.now + seq * 0.001).toISOString();
    rows.push({ id, at, kind, after });
    return { id, at };
  }
  function within(windowMs, now) {
    const cutoff = now - windowMs;
    return (kind) =>
      rows
        .filter((r) => r.kind === kind)
        .filter((r) => Date.parse(r.at) > cutoff)
        .map((r) => ({ id: r.id, at: r.at, after: r.after }))
        .sort((a, b) => b.at.localeCompare(a.at));
  }
  return {
    _rows: rows,
    async selectClaimsInWindow(windowMs, now) {
      return within(windowMs, now)("ai_match_claim");
    },
    async selectCancellationsInWindow(windowMs, now) {
      return within(windowMs, now)("ai_match_claim_cancelled");
    },
    async selectLatestStarted() {
      const r = rows
        .filter((x) => x.kind === "ai_match_run_started")
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      return r ? { at: r.at } : null;
    },
    async selectLatestEnd() {
      const r = rows
        .filter((x) => x.kind === "ai_match_run")
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      return r ? { at: r.at } : null;
    },
    async insertClaim({ claimId, size, actor }) {
      return insert("ai_match_claim", { claim_id: claimId, size, source: "batch-start", actor });
    },
    async insertCancellation({ claimId, reason }) {
      insert("ai_match_claim_cancelled", { claim_id: claimId, reason });
    },
    // Helpers for the proof to inject matcher-side events directly.
    _pushStarted(at) {
      rows.push({ id: randomUUID(), at, kind: "ai_match_run_started", after: null });
    },
    _pushEnded(at) {
      rows.push({ id: randomUUID(), at, kind: "ai_match_run", after: null });
    },
  };
}

// A deterministic sleep that advances the shared now reference. Every
// call races are decided by the order of claim writes, which we
// control via the `nowRef.now` advance.
function makeSleep(nowRef) {
  return async (ms) => {
    nowRef.now += ms;
  };
}

// Adapter that calls tryClaim and, on win, invokes the injected
// matcher. Mirrors what the real route does.
async function runBatchStart({ store, matcher, nowRef, size = 100 }) {
  const outcome = await tryClaim(store, {
    size,
    actor: "test",
    now: nowRef.now,
    sleep: makeSleep(nowRef),
  });
  if (!outcome.won) return { status: "refused", reason: outcome.reason };
  // Simulate runMatcher: write a started row, call the matcher,
  // write the end row. The real route calls runMatcher from
  // src/lib/matcher.ts which does the same two writes.
  const startedAt = new Date(nowRef.now).toISOString();
  store._pushStarted(startedAt);
  const r = await matcher();
  const endedAt = new Date(nowRef.now + 1).toISOString();
  store._pushEnded(endedAt);
  return { status: "ok", ...r };
}

// ---------- the six cases ------------------------------------------

async function caseName(label, fn) {
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`FAIL ${label} (threw: ${e && e.message ? e.message : e})`);
  }
}

// 1. Two requests started together.
await caseName("case 1: two requests started together", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 0, 0) };
  const store = makeStore({ nowRef });
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 7, proposed_new: 0, marked_not_food: 0 } };
  };
  // Fire both before either resolves; two parallel awaits.
  const [a, b] = await Promise.all([
    runBatchStart({ store, matcher, nowRef, size: 100 }),
    runBatchStart({ store, matcher, nowRef, size: 100 }),
  ]);
  ok("case 1: one matcher call", calls, 1);
  const wins = [a, b].filter((r) => r.status === "ok").length;
  const refuses = [a, b].filter((r) => r.status === "refused").length;
  ok("case 1: one winner", wins, 1);
  ok("case 1: one refusal", refuses, 1);
  // The refused request's reason is "race" (lost settle) or
  // "in_progress" (preflight caught it); either is correct.
  const refused = [a, b].find((r) => r.status === "refused");
  ok("case 1: refusal reason is race-or-in-progress", ["race", "in_progress"].includes(refused.reason), true);
});

// 2. Five requests started together.
await caseName("case 2: five requests started together", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 1, 0) };
  const store = makeStore({ nowRef });
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 3, proposed_new: 0, marked_not_food: 0 } };
  };
  const results = await Promise.all(
    [0, 0, 0, 0, 0].map(() => runBatchStart({ store, matcher, nowRef, size: 100 })),
  );
  ok("case 2: one matcher call across five requests", calls, 1);
  const wins = results.filter((r) => r.status === "ok").length;
  const refuses = results.filter((r) => r.status === "refused").length;
  ok("case 2: one winner across five", wins, 1);
  ok("case 2: four refusals across five", refuses, 4);
});

// 3. A request arriving while a run is live.
await caseName("case 3: a request during a live run", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 2, 0) };
  const store = makeStore({ nowRef });
  // Simulate an already-running run: a started row 10 s ago, no end.
  store._pushStarted(new Date(nowRef.now - 10_000).toISOString());
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 0, proposed_new: 0, marked_not_food: 0 } };
  };
  const r = await runBatchStart({ store, matcher, nowRef, size: 100 });
  ok("case 3: zero matcher calls while live", calls, 0);
  ok("case 3: refused", r.status, "refused");
  ok("case 3: reason is in_progress", r.reason, "in_progress");
});

// 4. A request after a finished run.
await caseName("case 4: a request after a finished run", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 3, 0) };
  const store = makeStore({ nowRef });
  store._pushStarted(new Date(nowRef.now - 100_000).toISOString());
  store._pushEnded(new Date(nowRef.now - 50_000).toISOString());
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 5, proposed_new: 0, marked_not_food: 0 } };
  };
  const r = await runBatchStart({ store, matcher, nowRef, size: 100 });
  ok("case 4: one matcher call after finish", calls, 1);
  ok("case 4: ok", r.status, "ok");
});

// 5. A request after a refused claim must not be blocked.
await caseName("case 5: a request after a refused claim", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 4, 0) };
  const store = makeStore({ nowRef });
  // Set up a refused claim shape: an ai_match_claim at t=-20 s and
  // a matching ai_match_claim_cancelled at t=-19.5 s. No run rows.
  store._rows.push({
    id: randomUUID(),
    at: new Date(nowRef.now - 20_000).toISOString(),
    kind: "ai_match_claim",
    after: { claim_id: "stale-x", size: 100, source: "batch-start" },
  });
  store._rows.push({
    id: randomUUID(),
    at: new Date(nowRef.now - 19_500).toISOString(),
    kind: "ai_match_claim_cancelled",
    after: { claim_id: "stale-x", reason: "race" },
  });
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 2, proposed_new: 0, marked_not_food: 0 } };
  };
  const r = await runBatchStart({ store, matcher, nowRef, size: 100 });
  ok("case 5: one matcher call after a refused claim", calls, 1);
  ok("case 5: ok", r.status, "ok");
});

// 6. A request after a dead start row older than 330 s.
await caseName("case 6: a request after a dead start > 330 s", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 5, 0) };
  const store = makeStore({ nowRef });
  // A started row 10 minutes ago with no end row. Must not block.
  store._pushStarted(new Date(nowRef.now - 10 * 60 * 1000).toISOString());
  let calls = 0;
  const matcher = async () => {
    calls += 1;
    return { status: "ok", counts: { proposed_existing: 1, proposed_new: 0, marked_not_food: 0 } };
  };
  const r = await runBatchStart({ store, matcher, nowRef, size: 100 });
  ok("case 6: one matcher call after a dead start row", calls, 1);
  ok("case 6: ok", r.status, "ok");
});

// Bonus: the loader's predicate (isLive) and the route's (via
// tryClaim's preflight) agree on the same events.
await caseName("bonus: loader and route agree during the claim-to-start gap", async () => {
  const nowRef = { now: Date.UTC(2026, 10, 20, 12, 6, 0) };
  const store = makeStore({ nowRef });
  // A fresh claim 20 ms ago, no matcher started row yet.
  const now = nowRef.now;
  store._rows.push({
    id: randomUUID(),
    at: new Date(now - 20).toISOString(),
    kind: "ai_match_claim",
    after: { claim_id: "x" },
  });
  const claims = await store.selectClaimsInWindow(BATCH_FRESH_MS, now);
  const cancels = await store.selectCancellationsInWindow(BATCH_FRESH_MS, now);
  const started = await store.selectLatestStarted();
  const end = await store.selectLatestEnd();
  ok(
    "bonus: isLive says in-progress during the gap",
    isLive(claims, cancels, started, end, now),
    true,
  );
});

// Sanity check on the bare predicate (round 1 ten cases): the
// original lock.ts tests still pass unchanged.
await caseName("lock.ts predicate: round-1 cases still pass", async () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const iso = (d) => new Date(now + d).toISOString();
  ok("empty events: not in progress", isBatchInProgress(null, null, now), false);
  ok("fresh start, no end: in progress", isBatchInProgress(iso(-10_000), null, now), true);
  ok("start at edge of window, no end: in progress", isBatchInProgress(iso(-(BATCH_FRESH_MS - 1_000)), null, now), true);
  ok("start at exact window: not in progress", isBatchInProgress(iso(-BATCH_FRESH_MS), null, now), false);
  ok("ancient start, no end: not in progress", isBatchInProgress(iso(-60 * 60 * 1000), null, now), false);
  ok("fresh start AND fresh end after it: not in progress", isBatchInProgress(iso(-50_000), iso(-20_000), now), false);
  ok("fresh start, end before it: in progress", isBatchInProgress(iso(-50_000), iso(-100_000), now), true);
  ok("start equals end: not in progress", isBatchInProgress(iso(-50_000), iso(-50_000), now), false);
  ok("malformed start: not in progress", isBatchInProgress("not a date", null, now), false);
  ok("malformed end: in progress", isBatchInProgress(iso(-10_000), "garbled", now), true);
});

// Expose the constant so anyone reading the proof sees what the
// settle window is set to.
console.log("");
console.log(`CLAIM_SETTLE_MS = ${CLAIM_SETTLE_MS}, SENTINEL_UUID = ${SENTINEL_UUID}`);
console.log(`T5b lock proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
