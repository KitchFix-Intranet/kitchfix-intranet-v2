// sc-64 (Kevin ruling 2026-11-16): the push, with retries.
//
// Three exported functions:
//   attemptPushForRow(rowId, deps?)        - one try, with claim
//   findAndAttemptDuePushRows(deps?)       - find all due and try each
//   pushAgain(rowId, supa?)                - human-driven, reset count
//
// Retries: every 10 minutes, six tries in all, then Kevin and
// Sebastian are told through the engine's existing failure notice.
// Not before. The notice is held back on tries 1 through 5 via the
// FinalizeDeps.fireN2 injection point; attempt 6 lets it fire once.
//
// Only rows marked submitted_via = 'v2' are ever touched.
//
// Claim: compare-and-swap through the client. Read the row, then
// UPDATE with the new values filtered on id, submitted_via='v2',
// push_attempts = <the value I read>, push_next_try_at at or before
// "now", push_done_at null, push_gave_up_at null, status <>
// 'reverted'. A row back means the claim is mine; nothing back
// means claim_lost. Postgres re-checks the filter under the row
// lock, so two runs cannot both win. "Now" is the app server's
// clock, passed as an ISO string. The 20-minute lease is written
// on claim; it is overwritten by the normal completion write.
// Consequence: a worker that dies mid-attempt leaves push_attempts
// one above where it was. After 20 minutes, the row is due again
// and attempt N+1 runs; attempt N is a lost completion write.
//
// Status transitions are set by this file explicitly:
//   claim                     push_attempts += 1, next_try moves to lease
//   attempt returned done     status='finalized', push_done_at=now, next_try=null
//   attempt returned failed   status='push_failed', next_try=now+10min (tries 1-5)
//                                                   next_try=null + gave_up (attempt 6)
//   attempt threw             same as returned failed (engine did not set status
//                             because it threw before transitionFinalizeRowToPushFailed)
//
// No path in this file ever writes status='billed'. v1 uses 'billed'
// to mean "cannot be reverted"; V2 success stays 'finalized' and
// is told apart by push_done_at. v1 stays the fallback.

import { getServiceClient } from "@/lib/sc/_seams";
import { runFinalizeEffects, type FinalizeDeps } from "@/lib/sc/scWeekFinalize";
import { fireN2 as defaultFireN2 } from "@/lib/sc/billing/qboNotifications";
import type {
  SupabaseClient,
  FinalizeRowWithRetry,
  PushAttemptResult,
  FireN2Result,
} from "@/lib/sc/types";

const RETRY_GAP_MINUTES = 10;
const LEASE_MINUTES     = 20;
const MAX_ATTEMPTS      = 6;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type PushDeps =
  & { supa?: SupabaseClient }
  & Pick<
      FinalizeDeps,
      "postInvoiceDraft" | "fireN1" | "fireN2" | "fireNoOpAlert" | "buildInvoicePayload" | "logger"
    >
  // Tests inject this to drive known runFinalizeEffects outcomes.
  // Production never passes it; the module-level `runFinalizeEffects`
  // import is the default.
  & { runFinalizeEffectsImpl?: typeof runFinalizeEffects };

// Hold-back stub used on tries 1..5. Non-sending shape. Subject
// says what happened so the engine's `[N2 fired]` log line is true.
// Typed as FireN2Result so no cast is needed at the call site.
function makeHeldBackN2(attempt: number): () => Promise<FireN2Result> {
  return async () => ({
    recipients: { to: [], cc: [] },
    subject:    `held: try ${attempt} of ${MAX_ATTEMPTS}, nobody told`,
    preheader:  "",
    html:       "",
    slack:      { text: "", result: { sent: false, skipped: "held" } },
    email:      { result: "not_sent" },
  });
}

export async function attemptPushForRow(
  rowId: string,
  deps?: PushDeps,
): Promise<PushAttemptResult> {
  const supa = deps?.supa || getServiceClient();

  // 1. Read the row. Only touches submitted_via='v2'.
  const { data: beforeRaw, error: readErr } = await supa
    .from("sc_week_finalize")
    .select("*")
    .eq("id", rowId)
    .maybeSingle();
  if (readErr) {
    throw new Error(`attemptPushForRow read: ${readErr.message}`);
  }
  if (!beforeRaw) return { done: false, state: "skipped", reason: "not_found" };
  const before = beforeRaw as FinalizeRowWithRetry;

  if (before.submitted_via !== "v2")       return { done: false, state: "skipped", reason: "not_v2" };
  if (before.status === "reverted")        return { done: false, state: "skipped", reason: "reverted" };
  if (before.push_done_at)                 return { done: false, state: "skipped", reason: "already_done" };
  if (before.push_gave_up_at)              return { done: false, state: "skipped", reason: "already_done" };
  if (!before.push_next_try_at)            return { done: false, state: "skipped", reason: "not_due" };

  const nowIso = new Date().toISOString();
  // Compare as times, not as text. The database writes timestamptz
  // with a `+00:00` offset; JavaScript writes `Z`. The claim's SQL
  // filter is the real guard; this is the pre-check only.
  if (Date.parse(before.push_next_try_at) > Date.parse(nowIso)) {
    return { done: false, state: "skipped", reason: "not_due" };
  }

  // 2. Claim via compare-and-swap. The filter re-checks under the
  // row lock. Two concurrent runs cannot both win.
  const leaseIso = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString();
  const claimedAttempt = before.push_attempts + 1;
  const { data: claimedRows, error: claimErr } = await supa
    .from("sc_week_finalize")
    .update({
      push_attempts:    claimedAttempt,
      push_next_try_at: leaseIso,
    })
    .eq("id", rowId)
    .eq("submitted_via", "v2")
    .eq("push_attempts", before.push_attempts)
    .lte("push_next_try_at", nowIso)
    .is("push_done_at", null)
    .is("push_gave_up_at", null)
    .neq("status", "reverted")
    .select("*");
  if (claimErr) {
    throw new Error(`attemptPushForRow claim: ${claimErr.message}`);
  }
  if (!claimedRows || claimedRows.length === 0) {
    return { done: false, state: "skipped", reason: "claim_lost" };
  }
  const claimed = claimedRows[0] as FinalizeRowWithRetry;

  // 3. Run the attempt. Suppress fireN2 for tries 1..5; on try 6 let
  // the real one go out (or whatever the caller passes).
  const isFinalAttempt = claimedAttempt >= MAX_ATTEMPTS;
  const effectiveFireN2 = isFinalAttempt
    ? (deps?.fireN2 ?? undefined)   // engine default fires the real notice
    : makeHeldBackN2(claimedAttempt);

  const ctx = {
    accountKey: claimed.account_key,
    weekStart:  claimed.week_start,
    finalizedRow: {
      id:            claimed.id,
      finalized_by:  claimed.finalized_by,
      finalized_at:  claimed.finalized_at,
    },
  };
  const effectsDeps: FinalizeDeps = {
    supa,
    postInvoiceDraft:    deps?.postInvoiceDraft,
    buildInvoicePayload: deps?.buildInvoicePayload,
    fireN1:              deps?.fireN1,
    fireN2:              effectiveFireN2,
    fireNoOpAlert:       deps?.fireNoOpAlert,
    logger:              deps?.logger,
  };

  type DoneState = "pushed" | "awaiting_pair_close" | "no_billable_actuals" | "already_invoiced";
  let outcome:
    | { kind: "done"; state: DoneState }
    | { kind: "failed"; error: string; cameFromThrow: boolean };
  const runEffects = deps?.runFinalizeEffectsImpl || runFinalizeEffects;
  try {
    const result = await runEffects(ctx, effectsDeps);
    if ("pushed" in result && result.pushed === true) {
      outcome = { kind: "done", state: "pushed" };
    } else if ("reason" in result) {
      // awaiting_pair_close | no_billable_actuals | already_invoiced
      outcome = { kind: "done", state: result.reason as "awaiting_pair_close" | "no_billable_actuals" | "already_invoiced" };
    } else {
      // pushed:false with failure object. The engine already fired
      // its fireN2 during this path (held-back stub for tries 1-5;
      // real notice on try 6).
      const message = typeof result.failure?.message === "string"
        ? result.failure.message
        : "unknown failure";
      outcome = { kind: "failed", error: message, cameFromThrow: false };
    }
  } catch (err) {
    // A throw from runFinalizeEffects is a failed try. The engine
    // threw before it could call its own transitionFinalizeRowToPushFailed
    // or its fireN2, so neither ran. This file writes
    // status='push_failed' in the completion write below; on attempt 6
    // we also fire the notice ourselves, once, with a catch so a
    // failing notice does not block the give-up write.
    outcome = {
      kind:  "failed",
      error: err instanceof Error ? err.message : String(err),
      cameFromThrow: true,
    };
  }

  // 4. Write the completion. Every write filters on submitted_via='v2'
  // and status <> 'reverted' so a week reverted while a try was in
  // flight is not written to by this layer.
  const nowIsoAfter = new Date().toISOString();

  if (outcome.kind === "done") {
    const { error: upErr } = await supa
      .from("sc_week_finalize")
      .update({
        status:           "finalized",
        push_done_at:     nowIsoAfter,
        push_next_try_at: null,
        push_last_error:  null,
      })
      .eq("id", rowId)
      .eq("submitted_via", "v2")
      .neq("status", "reverted");
    if (upErr) throw new Error(`attemptPushForRow completion: ${upErr.message}`);
    return { done: true, state: outcome.state };
  }

  // Failed path.
  const errMessage = outcome.error.slice(0, 500);
  if (claimedAttempt >= MAX_ATTEMPTS) {
    // Give up. Fire the failure notice ourselves if the engine threw
    // (engine's own fireN2 did not run on the throw path). On a
    // returned failure the engine already fired via effectiveFireN2
    // (which is the real one at this attempt), so the once-only
    // discipline is observed. A notice that itself fails is logged
    // without the address but does not block the give-up write.
    if (outcome.cameFromThrow) {
      try {
        const notifier = deps?.fireN2 || defaultFireN2;
        await notifier({
          qboMode: "test",
          accountKey: claimed.account_key,
          weekStart: claimed.week_start,
          weekEnd:   addDaysIso(claimed.week_start, 6),
          errorText: errMessage,
          attempt:   claimedAttempt,
        });
      } catch (notifyErr) {
        const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        console.error(`[sc/submit] attemptPushForRow give-up notice failed: ${msg}`);
      }
    }
    const { error: upErr } = await supa
      .from("sc_week_finalize")
      .update({
        status:           "push_failed",
        push_gave_up_at:  nowIsoAfter,
        push_next_try_at: null,
        push_last_error:  errMessage,
      })
      .eq("id", rowId)
      .eq("submitted_via", "v2")
      .neq("status", "reverted");
    if (upErr) throw new Error(`attemptPushForRow give-up: ${upErr.message}`);
    return { done: false, state: "gave_up", error: errMessage, attempt: claimedAttempt };
  }

  // Schedule the next try 10 minutes on.
  const nextIso = new Date(Date.now() + RETRY_GAP_MINUTES * 60_000).toISOString();
  const { error: upErr } = await supa
    .from("sc_week_finalize")
    .update({
      status:           "push_failed",
      push_next_try_at: nextIso,
      push_last_error:  errMessage,
    })
    .eq("id", rowId)
    .eq("submitted_via", "v2")
    .neq("status", "reverted");
  if (upErr) throw new Error(`attemptPushForRow failed-write: ${upErr.message}`);
  return { done: false, state: "failed", error: errMessage, attempt: claimedAttempt, nextTryAt: nextIso };
}

// Find every row that is due (submitted_via='v2', not reverted, not
// done, not given up, push_next_try_at <= now) and attempt each.
// One row's thrown error never stops the others.
export async function findAndAttemptDuePushRows(
  deps?: PushDeps,
): Promise<Array<{ rowId: string; result: PushAttemptResult | { done: false; state: "errored"; error: string } }>> {
  const supa = deps?.supa || getServiceClient();
  const nowIso = new Date().toISOString();

  const { data: dueRaw, error: dueErr } = await supa
    .from("sc_week_finalize")
    .select("id")
    .eq("submitted_via", "v2")
    .neq("status", "reverted")
    .is("push_done_at", null)
    .is("push_gave_up_at", null)
    .not("push_next_try_at", "is", null)
    .lte("push_next_try_at", nowIso)
    .order("push_next_try_at", { ascending: true });
  if (dueErr) {
    throw new Error(`findAndAttemptDuePushRows: ${dueErr.message}`);
  }

  const ids: string[] = (dueRaw || []).map((r: { id: string }) => r.id);
  const results: Array<{ rowId: string; result: PushAttemptResult | { done: false; state: "errored"; error: string } }> = [];
  for (const id of ids) {
    try {
      const result = await attemptPushForRow(id, deps);
      results.push({ rowId: id, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ rowId: id, result: { done: false, state: "errored", error: msg } });
    }
  }
  return results;
}

// Human-driven "push again" for a given-up row. Resets push_attempts
// to 0 for a fresh six-try run, clears push_gave_up_at, push_last_error
// and push_done_at, sets push_next_try_at to now. Filtered update so
// two humans pressing it at once cannot both win.
//
// Refusals: not_found; not_v2; not_given_up (otherwise a reset
// during a live run could start a second attempt in flight);
// reverted; already_done (push_done_at set).
export async function pushAgain(
  rowId: string,
  supaArg?: SupabaseClient,
): Promise<
  | { ok: true }
  | { ok: false; reason: "not_v2" | "not_found" | "not_given_up" | "reverted" | "already_done" | "race_lost" }
> {
  const supa = supaArg || getServiceClient();
  // Read first to give specific refusal reasons.
  const { data: beforeRaw, error: readErr } = await supa
    .from("sc_week_finalize")
    .select("submitted_via, status, push_done_at, push_gave_up_at")
    .eq("id", rowId)
    .maybeSingle();
  if (readErr) throw new Error(`pushAgain read: ${readErr.message}`);
  if (!beforeRaw) return { ok: false, reason: "not_found" };
  const before = beforeRaw as Pick<FinalizeRowWithRetry, "submitted_via" | "status" | "push_done_at" | "push_gave_up_at">;
  if (before.submitted_via !== "v2") return { ok: false, reason: "not_v2" };
  if (before.status === "reverted")  return { ok: false, reason: "reverted" };
  if (before.push_done_at)           return { ok: false, reason: "already_done" };
  if (!before.push_gave_up_at)       return { ok: false, reason: "not_given_up" };

  // Filtered update: two people pressing it at once -> only one wins.
  const nowIso = new Date().toISOString();
  const { data: updatedRows, error: upErr } = await supa
    .from("sc_week_finalize")
    .update({
      push_attempts:    0,
      push_next_try_at: nowIso,
      push_gave_up_at:  null,
      push_last_error:  null,
    })
    .eq("id", rowId)
    .eq("submitted_via", "v2")
    .neq("status", "reverted")
    .is("push_done_at", null)
    .not("push_gave_up_at", "is", null)
    .select("id");
  if (upErr) throw new Error(`pushAgain write: ${upErr.message}`);
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, reason: "race_lost" };
  }
  return { ok: true };
}
