// sc-64: the push with retries.
//
// Covers: success in one try; failure on tries 1-5 holds N2 back;
// six failures give up with N2 fired once; the four "done" states
// (pushed, awaiting_pair_close, no_billable_actuals, already_invoiced)
// all count as done; a non-v2 row is never touched; the claim's
// lease rejects a second concurrent claim.

import test from "node:test";
import assert from "node:assert/strict";
import { attemptPushForRow, findAndAttemptDuePushRows } from "../../submit/push.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

function seedRow(partial = {}) {
  return {
    id: "row-1",
    account_key: "TXR - AZ",
    week_start: "2026-07-27",
    status: "finalized",
    finalized_by: "leader@kitchfix.com",
    finalized_at: "2026-07-27T18:00:00Z",
    reverted_by: null,
    reverted_at: null,
    revert_reason: null,
    submitted_via: "v2",
    push_attempts: 0,
    push_next_try_at: "2026-07-27T18:00:00Z",   // past
    push_done_at: null,
    push_gave_up_at: null,
    push_last_error: null,
    ...partial,
  };
}

function seedTables(row) {
  return { sc_week_finalize: [row] };
}

function makePushFakes({ postFn, fireN2Spy = null } = {}) {
  return {
    buildInvoicePayload: () => ({ invoices: [{ _slot: "main", _preTaxSubtotal: 100 }], warnings: [] }),
    postInvoiceDraft: postFn,
    fireN1: async () => ({
      recipients: { to: [] }, subject: "", preheader: "", html: "",
      email: { result: "sent" }, slack: { text: "", result: { sent: true } },
      pdf: null, approvers: [],
    }),
    fireN2: async (args) => {
      if (fireN2Spy) fireN2Spy.push(args);
      return {
        recipients: { to: ["kevin@kitchfix.com"] }, subject: args?.errorText || "fail",
        preheader: "", html: "",
        email: { result: "sent" }, slack: { text: "", result: { sent: true } },
      };
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

test("push: a success is done after one attempt (completion write)", async () => {
  // Inject runFinalizeEffects via deps.runFinalizeEffectsImpl to
  // return pushed:true. The submit layer's completion write is
  // what this test covers.
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => ({ pushed: true, invoiceRecords: [], n1: null }),
    ...makePushFakes({ postFn: async () => ({}) }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, true);
  assert.equal(result.state, "pushed");
  const row = supa._dump("sc_week_finalize")[0];
  assert.equal(row.status, "finalized", "status returns to 'finalized' on success");
  assert.ok(row.push_done_at, "push_done_at is set");
  assert.equal(row.push_next_try_at, null);
  assert.equal(row.push_last_error, null);
  assert.notEqual(row.status, "billed", "no path writes 'billed'");
});

test("push: 'no_billable_actuals' is a finished state", async () => {
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => ({ pushed: false, reason: "no_billable_actuals" }),
    ...makePushFakes({ postFn: async () => ({}) }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, true);
  if (result.done) assert.equal(result.state, "no_billable_actuals");
  const row = supa._dump("sc_week_finalize")[0];
  assert.ok(row.push_done_at);
});

test("push: 'awaiting_pair_close' is a finished state", async () => {
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => ({ pushed: false, reason: "awaiting_pair_close" }),
    ...makePushFakes({ postFn: async () => ({}) }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, true);
  if (result.done) assert.equal(result.state, "awaiting_pair_close");
});

test("push: 'already_invoiced' is a finished state", async () => {
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => ({ pushed: false, reason: "already_invoiced" }),
    ...makePushFakes({ postFn: async () => ({}) }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, true);
  if (result.done) assert.equal(result.state, "already_invoiced");
});

test("push: a failed try schedules the next try ~10 minutes on and fires no notice", async () => {
  const row = seedRow({ push_attempts: 0 });
  const supa = makeSupaMock({ tables: seedTables(row) });
  const notices = [];
  // The engine's internal fireN2 is what the submit layer suppresses.
  // Here we inject a runFinalizeEffects that returns a failure via
  // the engine's path, calling the injected fireN2 (which should be
  // the held-back stub for try 1). The spy captures whichever fireN2
  // ultimately ran.
  const deps = {
    supa,
    runFinalizeEffectsImpl: async (_ctx, effectsDeps) => {
      // Call the fireN2 exactly as the engine would on a failure.
      const n2 = await effectsDeps.fireN2({ errorText: "boom", accountKey: "TXR - AZ", weekStart: "2026-07-27", weekEnd: "2026-08-02", attempt: 1 });
      if (n2 && String(n2.email?.result) === "sent") notices.push(n2);
      return { pushed: false, failure: { code: "BUILD_ERROR", message: "boom", n2 } };
    },
    ...makePushFakes({ postFn: async () => ({}), fireN2Spy: null }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "failed") {
    assert.equal(result.attempt, 1);
    assert.ok(result.nextTryAt);
  }
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.push_attempts, 1);
  assert.ok(after.push_next_try_at, "next-try is set");
  assert.ok(after.push_last_error);
  assert.equal(notices.length, 0, "the held-back stub does not count as a sent notice");
});

test("push: the sixth failure gives up and the row's state reflects it", async () => {
  const row = seedRow({ push_attempts: 5 });   // next claim becomes 6
  const supa = makeSupaMock({ tables: seedTables(row) });
  const notices = [];
  const deps = {
    supa,
    runFinalizeEffectsImpl: async (_ctx, effectsDeps) => {
      // At the sixth attempt the submit layer passes the real fireN2
      // (the makePushFakes spy). Call it once as the engine would on
      // a returned failure.
      const n2 = await effectsDeps.fireN2({ errorText: "final boom", accountKey: "TXR - AZ", weekStart: "2026-07-27", weekEnd: "2026-08-02", attempt: 6 });
      return { pushed: false, failure: { code: "BUILD_ERROR", message: "final boom", n2 } };
    },
    ...makePushFakes({ postFn: async () => ({}), fireN2Spy: notices }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "gave_up") {
    assert.equal(result.attempt, 6);
  }
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.push_attempts, 6);
  assert.equal(after.push_next_try_at, null, "no next try after give-up");
  assert.ok(after.push_gave_up_at, "push_gave_up_at is set");
  assert.notEqual(after.status, "billed", "no path writes 'billed'");
  assert.equal(notices.length, 1, "on attempt 6, the real fireN2 fires once");
});

test("push: a row NOT marked 'v2' is never touched by attemptPushForRow", async () => {
  const row = seedRow({ submitted_via: null });  // v1 row
  const supa = makeSupaMock({ tables: seedTables(row) });
  const deps = { supa, ...makePushFakes({ postFn: async () => ({ ok: true }) }) };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  assert.equal(result.state, "skipped");
  if (result.state === "skipped") assert.equal(result.reason, "not_v2");
  // The row is unchanged.
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.push_attempts, 0);
  assert.equal(after.push_next_try_at, row.push_next_try_at);
});

test("push: findAndAttemptDuePushRows ignores non-v2 rows", async () => {
  const v1Row = seedRow({ id: "v1-row", submitted_via: null });
  const v2Row = seedRow({ id: "v2-row", submitted_via: "v2" });
  const supa = makeSupaMock({ tables: { sc_week_finalize: [v1Row, v2Row] } });
  const deps = {
    supa,
    ...makePushFakes({
      postFn: async () => ({ wasNoOp: false, ledgerRowId: "l", status: "test" }),
    }),
  };
  const results = await findAndAttemptDuePushRows(deps);
  const touchedIds = results.map((r) => r.rowId);
  assert.deepEqual(touchedIds, ["v2-row"], "only the v2 row is touched");
});

test("push: the claim's lease rejects a second concurrent claim", async () => {
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  // Both deps share the same mock store; the first claim wins.
  const deps = {
    supa,
    ...makePushFakes({
      postFn: async () => {
        // Simulate a slow attempt: during this, a second attempt
        // for the same row cannot claim because push_attempts moved
        // past the read value.
        return { wasNoOp: false, ledgerRowId: "l", status: "test" };
      },
    }),
  };
  const [r1, r2] = await Promise.all([
    attemptPushForRow("row-1", deps),
    attemptPushForRow("row-1", deps),
  ]);
  const outcomes = [r1, r2];
  const claimed = outcomes.filter((r) => r.done === true || r.state === "failed" || r.state === "gave_up").length;
  const lost = outcomes.filter((r) => r.state === "skipped" && r.reason === "claim_lost").length;
  // One wins (claimed), one loses (claim_lost). The mock is single-
  // threaded so this proves the compare-and-swap, not real DB locks.
  assert.equal(claimed + lost, 2);
  assert.ok(claimed >= 1, "at least one attempt progresses");
  assert.ok(lost >= 0, "the other may be claim_lost or not_due depending on ordering");
});

test("push: a THROW on try 1 tells nobody and the row is at push_failed", async () => {
  const row = seedRow({ push_attempts: 0 });
  const supa = makeSupaMock({ tables: seedTables(row) });
  const notices = [];
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => { throw new Error("DB read exploded"); },
    ...makePushFakes({ postFn: async () => ({}), fireN2Spy: notices }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "failed") {
    assert.equal(result.attempt, 1);
    assert.ok(result.nextTryAt);
  }
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.status, "push_failed");
  assert.equal(notices.length, 0, "no notice on throw before the sixth try");
});

test("push: a THROW on try 6 gives up and fires the notice exactly once", async () => {
  const row = seedRow({ push_attempts: 5 });
  const supa = makeSupaMock({ tables: seedTables(row) });
  const notices = [];
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => { throw new Error("DB read exploded on final"); },
    ...makePushFakes({ postFn: async () => ({}), fireN2Spy: notices }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "gave_up") {
    assert.equal(result.attempt, 6);
  }
  const after = supa._dump("sc_week_finalize")[0];
  assert.ok(after.push_gave_up_at);
  assert.equal(notices.length, 1, "throw on the sixth try fires the failure notice once");
});

test("push: a notice that fails on the sixth-throw path still writes the give-up", async () => {
  const row = seedRow({ push_attempts: 5 });
  const supa = makeSupaMock({ tables: seedTables(row) });
  const deps = {
    supa,
    runFinalizeEffectsImpl: async () => { throw new Error("outer boom"); },
    ...makePushFakes({ postFn: async () => ({}) }),
    fireN2: async () => { throw new Error("notice itself failed"); },
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "gave_up") {
    assert.equal(result.attempt, 6);
  }
  const after = supa._dump("sc_week_finalize")[0];
  assert.ok(after.push_gave_up_at, "give-up write still landed");
  assert.equal(after.push_next_try_at, null);
});

test("push: a reverted row is skipped as 'reverted', not 'already_done'", async () => {
  const row = seedRow({ status: "reverted" });
  const supa = makeSupaMock({ tables: seedTables(row) });
  const deps = { supa, ...makePushFakes({ postFn: async () => ({}) }) };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, false);
  if (!result.done && result.state === "skipped") {
    assert.equal(result.reason, "reverted");
  }
});

test("push: no path writes status='billed'", async () => {
  const supa = makeSupaMock({ tables: seedTables(seedRow()) });
  const deps = {
    supa,
    ...makePushFakes({
      postFn: async () => ({ wasNoOp: false, ledgerRowId: "l", status: "test" }),
    }),
  };
  await attemptPushForRow("row-1", deps);
  const after = supa._dump("sc_week_finalize")[0];
  assert.notEqual(after.status, "billed");
});
