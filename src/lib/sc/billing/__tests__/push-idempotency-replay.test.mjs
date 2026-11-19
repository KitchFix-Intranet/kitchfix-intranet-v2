// Idempotency replay: calling attemptPushForRow a second time on a
// row that already pushed must NOT re-post to QuickBooks.
//
// Two defenses stack:
//   1. Outer: push.ts refuses when push_done_at is set
//      (returns { done: false, state: "skipped", reason: "already_done" }).
//      This is the first thing hit on the replay. QuickBooks is
//      never called.
//   2. Inner: if someone ever disables the outer, the engine's own
//      idempotency sees the deterministic DocNumber and returns
//      { pushed: false, reason: "already_invoiced" }. This test
//      also verifies that shape writes a "done" row, not a failed
//      one, so a replay can safely stand in for the first push if
//      the first one was interrupted mid-write.
//
// This covers the Chat-Claude pin: "run attemptPushForRow twice
// with a fake postInvoiceDraft returning { reason: 'already_invoiced' }
// on the second call" - mapped onto the deps surface, that is a
// runFinalizeEffectsImpl returning the "already_invoiced" reason.

import test from "node:test";
import assert from "node:assert/strict";
import { attemptPushForRow } from "../../submit/push.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

function seedRow(partial = {}) {
  return {
    id: "row-1",
    account_key: "ACCT-A - YY",
    week_start: "2026-07-27",
    status: "finalized",
    finalized_by: "leader@kitchfix.com",
    finalized_at: "2026-07-27T18:00:00Z",
    reverted_by: null,
    reverted_at: null,
    revert_reason: null,
    submitted_via: "v2",
    push_attempts: 0,
    push_next_try_at: "2026-07-27T18:00:00Z",
    push_done_at: null,
    push_gave_up_at: null,
    push_last_error: null,
    ...partial,
  };
}

test("idempotency: a second attemptPushForRow on a pushed row is skipped (outer defense)", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow()] } });
  let effectCallCount = 0;
  const deps = {
    supa,
    buildInvoicePayload: () => ({ invoices: [{ _slot: "main", _preTaxSubtotal: 100 }], warnings: [] }),
    postInvoiceDraft: async () => ({}),
    fireN1: async () => ({}),
    fireN2: async () => ({}),
    logger: { info: () => {}, warn: () => {} },
    runFinalizeEffectsImpl: async () => {
      effectCallCount += 1;
      return { pushed: true, invoiceRecords: [], n1: null };
    },
  };
  const first = await attemptPushForRow("row-1", deps);
  assert.equal(first.done, true);
  assert.equal(first.state, "pushed");
  assert.equal(effectCallCount, 1);

  const row = supa._dump("sc_week_finalize")[0];
  assert.ok(row.push_done_at);
  assert.equal(row.status, "finalized");

  const second = await attemptPushForRow("row-1", deps);
  assert.equal(second.done, false);
  assert.equal(second.state, "skipped");
  assert.equal(second.reason, "already_done");
  assert.equal(effectCallCount, 1, "engine must not run a second time - no replay post");
});

test("idempotency: engine 'already_invoiced' lands as done, not failed (inner defense)", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow()] } });
  const deps = {
    supa,
    buildInvoicePayload: () => ({ invoices: [{ _slot: "main", _preTaxSubtotal: 100 }], warnings: [] }),
    postInvoiceDraft: async () => ({}),
    fireN1: async () => ({}),
    fireN2: async () => ({}),
    logger: { info: () => {}, warn: () => {} },
    runFinalizeEffectsImpl: async () => ({ pushed: false, reason: "already_invoiced" }),
  };
  const result = await attemptPushForRow("row-1", deps);
  assert.equal(result.done, true);
  assert.equal(result.state, "already_invoiced");
  const row = supa._dump("sc_week_finalize")[0];
  assert.equal(row.status, "finalized");
  assert.ok(row.push_done_at, "already_invoiced writes push_done_at - a replay on the next tick is skipped");
  assert.equal(row.push_last_error, null);
});
