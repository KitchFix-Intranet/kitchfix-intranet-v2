// sc-64: push again.

import test from "node:test";
import assert from "node:assert/strict";
import { pushAgain } from "../../submit/push.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

function seedRow(partial = {}) {
  return {
    id: "row-1",
    account_key: "TXR - AZ",
    week_start: "2026-07-27",
    status: "push_failed",
    finalized_by: "leader@kitchfix.com",
    finalized_at: "2026-07-27T18:00:00Z",
    reverted_by: null,
    reverted_at: null,
    revert_reason: null,
    submitted_via: "v2",
    push_attempts: 6,
    push_next_try_at: null,
    push_done_at: null,
    push_gave_up_at: "2026-07-27T20:00:00Z",
    push_last_error: "gave up after six tries",
    ...partial,
  };
}

test("pushAgain: a given-up v2 row is reset to a fresh six-try run", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow()] } });
  const got = await pushAgain("row-1", supa);
  assert.deepEqual(got, { ok: true });
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.push_attempts, 0, "reset to 0 - the operator gets a clean six-try run");
  assert.ok(after.push_next_try_at, "due immediately");
  assert.equal(after.push_gave_up_at, null);
  assert.equal(after.push_last_error, null);
});

test("pushAgain: refuses a row that is not marked 'v2'", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow({ submitted_via: null })] } });
  const got = await pushAgain("row-1", supa);
  assert.deepEqual(got, { ok: false, reason: "not_v2" });
  const after = supa._dump("sc_week_finalize")[0];
  assert.equal(after.push_attempts, 6, "untouched");
});

test("pushAgain: refuses a reverted row", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [seedRow({ status: "reverted" })] } });
  const got = await pushAgain("row-1", supa);
  assert.deepEqual(got, { ok: false, reason: "reverted" });
});

test("pushAgain: refuses a row that has not given up (otherwise a reset could start a second attempt in flight)", async () => {
  // Row in flight: push_attempts = 2, push_next_try_at set, no gave_up.
  const supa = makeSupaMock({
    tables: {
      sc_week_finalize: [seedRow({
        push_attempts: 2, push_next_try_at: "2027-01-01T00:00:00Z", push_gave_up_at: null,
      })],
    },
  });
  const got = await pushAgain("row-1", supa);
  assert.deepEqual(got, { ok: false, reason: "not_given_up" });
});

test("pushAgain: refuses an already-done row", async () => {
  const supa = makeSupaMock({
    tables: {
      sc_week_finalize: [seedRow({
        push_done_at: "2026-07-27T19:00:00Z", push_gave_up_at: null,
      })],
    },
  });
  const got = await pushAgain("row-1", supa);
  assert.deepEqual(got, { ok: false, reason: "already_done" });
});

test("pushAgain: refuses a row that does not exist", async () => {
  const supa = makeSupaMock({ tables: { sc_week_finalize: [] } });
  const got = await pushAgain("no-such-row", supa);
  assert.deepEqual(got, { ok: false, reason: "not_found" });
});
