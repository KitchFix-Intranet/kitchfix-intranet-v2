// Gap B regression: if sc_week_finalize.status is flipped to
// 'reverted' WHILE a push attempt is in flight, the completion
// write must not overwrite that revert.
//
// Shape under test (push.ts): every completion update filters
// `.neq("status", "reverted")`. This test exercises that filter by
// simulating a revert between the claim-time read and the
// completion write: a runFinalizeEffectsImpl that flips the row to
// 'reverted' before returning. The completion write happens next;
// the row must stay at 'reverted' afterwards.
//
// This is a safeguard, not a fix: the filter already exists in
// push.ts. The test exists so a future rewrite that drops the
// filter fails loudly, not silently with a revert-overwrite.

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

function makeFakes(sideEffect) {
  return {
    buildInvoicePayload: () => ({ invoices: [{ _slot: "main", _preTaxSubtotal: 100 }], warnings: [] }),
    postInvoiceDraft: async () => ({}),
    fireN1: async () => ({}),
    fireN2: async () => ({}),
    logger: { info: () => {}, warn: () => {} },
    runFinalizeEffectsImpl: async () => {
      await sideEffect();
      return { pushed: true, invoiceRecords: [], n1: null };
    },
  };
}

test("Gap B: a success-path completion does NOT overwrite a revert that happened during the try", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow()] } });

  // While the engine is running, the office reverts the week. Mimic
  // the sc-revert path: status -> 'reverted'.
  const revert = async () => {
    await supa
      .from("sc_week_finalize")
      .update({ status: "reverted", reverted_at: new Date().toISOString() })
      .eq("id", "row-1");
  };

  const deps = { supa, ...makeFakes(revert) };
  const result = await attemptPushForRow("row-1", deps);

  // Push returns done (the engine said pushed); the row stays reverted.
  assert.equal(result.done, true);
  assert.equal(result.state, "pushed");
  const row = supa._dump("sc_week_finalize")[0];
  assert.equal(row.status, "reverted", "status must remain reverted - the .neq filter blocks the completion write from overwriting");
  assert.equal(row.push_done_at, null, "push_done_at was not written because the row was already reverted");
});

test("Gap B: a failed-path completion also does NOT overwrite a revert (status stays reverted)", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow()] } });

  const revert = async () => {
    await supa
      .from("sc_week_finalize")
      .update({ status: "reverted", reverted_at: new Date().toISOString() })
      .eq("id", "row-1");
  };

  const deps = {
    supa,
    buildInvoicePayload: () => ({ invoices: [{ _slot: "main", _preTaxSubtotal: 100 }], warnings: [] }),
    postInvoiceDraft: async () => ({}),
    fireN1: async () => ({}),
    fireN2: async () => ({}),
    logger: { info: () => {}, warn: () => {} },
    runFinalizeEffectsImpl: async () => {
      await revert();
      return { pushed: false, failure: { code: "ADAPTER_ERR", message: "simulated" } };
    },
  };
  await attemptPushForRow("row-1", deps);
  const row = supa._dump("sc_week_finalize")[0];
  assert.equal(row.status, "reverted", "the failure-path completion write is also filtered by .neq(status, reverted)");
});
