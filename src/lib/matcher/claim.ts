// T5b round 2 item 2: one-run-at-a-time, claim-first. Two concurrent
// presses must not both start a run. The route writes its own claim
// row BEFORE calling runMatcher, waits for any racing claim to land,
// then reads back the window and goes ahead only if its own claim is
// the earliest live one. A loser cancels its own claim so the next
// press is not blocked by it.
//
// Clock: every timestamp decision uses the database's `at` column
// for ordering. The route never compares the server's wall clock
// to the database's. `now` only decides whether the window has
// elapsed and is stable within a single request.
//
// The claim and run event shapes live in pr_events (free-text
// `kind`, no schema change needed):
//
//   kind = "ai_match_claim"
//     after = { claim_id, size, source: "batch-start" }
//
//   kind = "ai_match_claim_cancelled"
//     after = { claim_id, reason: "race" | ... }
//
//   kind = "ai_match_run_started"   (matcher.ts writes this)
//   kind = "ai_match_run"           (matcher.ts writes this)
//
// The tryClaim function takes an EventsStore so the proof can inject
// a stand-in that counts matcher calls. The real store wraps the
// Supabase client in makeEventsStore (see below). The loader's "is a
// run live" check reads the same four event streams via the same
// predicate in isLive.
//
// If this file's shape ever diverges from /api/review/batch-start or
// loadReview, the proof scripts fail, not the user.

import { randomUUID } from "node:crypto";
import { BATCH_FRESH_MS } from "./lock";

export const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";
// How long the route waits after writing its claim before re-reading
// the window to decide the winner. A racing claim from another tab
// has to land within this window; past it, we commit. 150 ms covers
// typical Postgres write round-trip + network jitter without making
// the user wait a visible amount.
export const CLAIM_SETTLE_MS = 150;

export type ClaimEventRow = {
  id: string;
  at: string;
  after: { claim_id?: string; size?: number; source?: string; reason?: string } | null;
};

export type EventsStore = {
  selectClaimsInWindow: (windowMs: number, now: number) => Promise<ClaimEventRow[]>;
  selectCancellationsInWindow: (windowMs: number, now: number) => Promise<ClaimEventRow[]>;
  selectLatestStarted: () => Promise<{ at: string } | null>;
  selectLatestEnd: () => Promise<{ at: string } | null>;
  insertClaim: (payload: { claimId: string; size: number; actor: string | null }) => Promise<{ at: string }>;
  insertCancellation: (payload: { claimId: string; reason: string }) => Promise<void>;
};

export type ClaimOutcome =
  | { won: true; claimId: string }
  | { won: false; reason: "in_progress" | "race" };

// Predicate used by the loader AND by tryClaim's preflight. A run is
// live when either (a) an un-cancelled claim is still in the window
// AND no ai_match_run has fired after it, or (b) a matcher-internal
// started row is in the window and no ai_match_run has fired after
// it. Both branches honour the same freshness window so a dead
// claim or a dead start never blocks a future press.
export function isLive(
  claims: ClaimEventRow[],
  cancellations: ClaimEventRow[],
  latestStarted: { at: string } | null,
  latestEnd: { at: string } | null,
  now: number,
): boolean {
  const endMs = latestEnd ? Date.parse(latestEnd.at) : 0;
  const cancelledIds = new Set(
    cancellations
      .map((c) => c.after?.claim_id)
      .filter((v): v is string => typeof v === "string"),
  );
  const activeClaims = claims.filter((c) => {
    const id = c.after?.claim_id;
    if (!id) return false;
    if (cancelledIds.has(id)) return false;
    const claimMs = Date.parse(c.at);
    if (!Number.isFinite(claimMs)) return false;
    if (claimMs <= endMs) return false;
    if (now - claimMs >= BATCH_FRESH_MS) return false;
    return true;
  });
  if (activeClaims.length > 0) return true;
  if (!latestStarted) return false;
  const startedMs = Date.parse(latestStarted.at);
  if (!Number.isFinite(startedMs)) return false;
  if (now - startedMs >= BATCH_FRESH_MS) return false;
  return startedMs > endMs;
}

// The ratchet: after the settle window, the EARLIEST live claim in
// the window wins. Ties on `at` (Postgres microsecond) break on `id`
// deterministically.
function pickWinner(claims: ClaimEventRow[]): ClaimEventRow | null {
  const valid = claims.filter((c) => typeof c.after?.claim_id === "string");
  if (valid.length === 0) return null;
  return valid.slice().sort((a, b) => {
    const ad = a.at.localeCompare(b.at);
    if (ad !== 0) return ad;
    return a.id.localeCompare(b.id);
  })[0];
}

export async function tryClaim(
  store: EventsStore,
  opts: {
    size: number;
    actor: string | null;
    now?: number;
    sleep?: (ms: number) => Promise<void>;
    // The proof overrides randomUUID so case ordering is readable.
    makeId?: () => string;
  },
): Promise<ClaimOutcome> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const makeId = opts.makeId ?? randomUUID;
  const now = opts.now ?? Date.now();

  // Preflight: a live claim or live matcher run refuses before we
  // write anything. The route surfaces this as 409 / "A batch is
  // already running. Nothing new was started."
  const [claims0, cancels0, started0, end0] = await Promise.all([
    store.selectClaimsInWindow(BATCH_FRESH_MS, now),
    store.selectCancellationsInWindow(BATCH_FRESH_MS, now),
    store.selectLatestStarted(),
    store.selectLatestEnd(),
  ]);
  if (isLive(claims0, cancels0, started0, end0, now)) {
    return { won: false, reason: "in_progress" };
  }

  // Claim first. The INSERT returns the Postgres-assigned `at`, so
  // any ordering decision uses one clock (the database's).
  const claimId = makeId();
  await store.insertClaim({ claimId, size: opts.size, actor: opts.actor });

  // Wait for a racing claim to land.
  await sleep(CLAIM_SETTLE_MS);

  // Re-read the window and apply the ratchet. If our claim is the
  // earliest active one, we go ahead; otherwise we cancel our own
  // claim (so the next press is not blocked by it) and refuse.
  const [claims1, cancels1, end1] = await Promise.all([
    store.selectClaimsInWindow(BATCH_FRESH_MS, now),
    store.selectCancellationsInWindow(BATCH_FRESH_MS, now),
    store.selectLatestEnd(),
  ]);
  const endMs = end1 ? Date.parse(end1.at) : 0;
  const cancelledIds = new Set(
    cancels1
      .map((c) => c.after?.claim_id)
      .filter((v): v is string => typeof v === "string"),
  );
  const activeClaims = claims1.filter((c) => {
    const id = c.after?.claim_id;
    if (!id) return false;
    if (cancelledIds.has(id)) return false;
    const claimMs = Date.parse(c.at);
    if (!Number.isFinite(claimMs)) return false;
    return claimMs > endMs;
  });
  const winner = pickWinner(activeClaims);
  if (winner && winner.after?.claim_id === claimId) {
    return { won: true, claimId };
  }

  // We lost (or every claim in the window was cancelled). Cancel
  // ourselves so the next press is free to run.
  await store.insertCancellation({ claimId, reason: "race" });
  return { won: false, reason: "race" };
}

// The real store. Thin wrapper over the service client.
import type { SupabaseClient } from "@supabase/supabase-js";

export function makeEventsStore(client: SupabaseClient): EventsStore {
  const WINDOW = 50; // paginate claim reads
  async function selectEventsInWindow(kind: string, windowMs: number, now: number) {
    const cutoff = new Date(now - windowMs).toISOString();
    const { data, error } = await client
      .from("pr_events")
      .select("id,at,after")
      .eq("entity_type", "matcher")
      .eq("kind", kind)
      .gt("at", cutoff)
      .order("at", { ascending: false })
      .limit(WINDOW);
    if (error) throw error;
    return (data ?? []) as unknown as ClaimEventRow[];
  }
  return {
    selectClaimsInWindow(windowMs, now) {
      return selectEventsInWindow("ai_match_claim", windowMs, now);
    },
    selectCancellationsInWindow(windowMs, now) {
      return selectEventsInWindow("ai_match_claim_cancelled", windowMs, now);
    },
    async selectLatestStarted() {
      const { data, error } = await client
        .from("pr_events")
        .select("at")
        .eq("entity_type", "matcher")
        .eq("kind", "ai_match_run_started")
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { at: string } | null) ?? null;
    },
    async selectLatestEnd() {
      const { data, error } = await client
        .from("pr_events")
        .select("at")
        .eq("entity_type", "matcher")
        .eq("kind", "ai_match_run")
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { at: string } | null) ?? null;
    },
    async insertClaim({ claimId, size, actor }) {
      const { data, error } = await client
        .from("pr_events")
        .insert({
          entity_type: "matcher",
          entity_id: SENTINEL_UUID,
          kind: "ai_match_claim",
          actor,
          after: { claim_id: claimId, size, source: "batch-start" },
        })
        .select("at")
        .maybeSingle();
      if (error) throw error;
      return { at: (data?.at as string) ?? new Date().toISOString() };
    },
    async insertCancellation({ claimId, reason }) {
      const { error } = await client
        .from("pr_events")
        .insert({
          entity_type: "matcher",
          entity_id: SENTINEL_UUID,
          kind: "ai_match_claim_cancelled",
          actor: null,
          after: { claim_id: claimId, reason },
        });
      if (error) throw error;
    },
  };
}

// Loader convenience: one function reads all four streams and
// returns the predicate's answer. Used by loadReview so the page's
// in-progress state matches the route's view.
export async function isBatchLiveFromClient(
  client: SupabaseClient,
  now: number,
): Promise<boolean> {
  const store = makeEventsStore(client);
  const [claims, cancels, started, end] = await Promise.all([
    store.selectClaimsInWindow(BATCH_FRESH_MS, now),
    store.selectCancellationsInWindow(BATCH_FRESH_MS, now),
    store.selectLatestStarted(),
    store.selectLatestEnd(),
  ]);
  return isLive(claims, cancels, started, end, now);
}
