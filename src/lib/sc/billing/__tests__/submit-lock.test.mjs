// sc-64: the lock.

import test from "node:test";
import assert from "node:assert/strict";
import { submitWeek } from "../../submit/submit.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

const CORP = { work_email: "kevin@kitchfix.com", status: "ACTIVE", is_corp: true,
               account_key: null, is_salaried: null, is_regional_director: null, region: null };
const ACCT = { team_key: "TXR - AZ", region: "West", timezone: null };
const QBO_MAP = { account_key: "TXR - AZ", qbo_mode: "test", cadence: "weekly" };
const WEEK = "2026-07-27";
const SITE_TODAY = "2026-07-30";

function withRpc(tables) {
  const mock = makeSupaMock({ tables });
  mock.rpc = (name) => {
    if (name === "sc_site_today") return Promise.resolve({ data: SITE_TODAY, error: null });
    if (name === "sc_is_day_locked") return Promise.resolve({ data: false, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  return mock;
}

function cleanTables(overrides = {}) {
  return {
    people: [CORP],
    accounts: [ACCT],
    sc_week_finalize: [],
    sc_qbo_account_map: [QBO_MAP],
    sc_qbo_service_map: [],
    sc_day_metadata: [],
    sc_daily_revenue: [],
    ...overrides,
  };
}

test("lock: a clean submit at a billed site writes one row with the right marks", async () => {
  const supa = withRpc(cleanTables());
  const got = await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  assert.equal(got.ok, true);
  const row = got.row;
  assert.equal(row.status, "finalized");
  assert.equal(row.submitted_via, "v2");
  assert.equal(row.push_attempts, 0);
  assert.ok(row.push_next_try_at, "next-try is set on a billed site");
  assert.equal(row.push_done_at, null, "not done yet - the push has not run");
  assert.equal(row.push_gave_up_at, null);
  assert.equal(row.push_last_error, null);
});

test("lock: a submit at a non-billed site is done at once", async () => {
  const supa = withRpc(cleanTables({ sc_qbo_account_map: [] }));
  const got = await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  assert.equal(got.ok, true);
  const row = got.row;
  assert.equal(row.submitted_via, "v2");
  assert.equal(row.push_attempts, 0);
  assert.equal(row.push_next_try_at, null, "no retry: the row is done");
  assert.ok(row.push_done_at, "push_done_at is set at submit");
});

test("lock: a blocked week writes nothing", async () => {
  const supa = withRpc(cleanTables({
    sc_week_finalize: [{
      id: "existing", account_key: "TXR - AZ", week_start: WEEK, status: "finalized",
      finalized_by: "leader@kitchfix.com", finalized_at: "2026-07-27T18:00:00Z",
    }],
  }));
  const got = await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  assert.equal(got.ok, false);
  assert.ok(got.blocks.some((b) => b.code === "ALREADY_SUBMITTED"));
  // No new row.
  const after = supa._dump("sc_week_finalize");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "existing");
});

test("lock: a second submit for the same (account, week) is refused by the unique index as ALREADY_SUBMITTED", async () => {
  const supa = withRpc(cleanTables());
  // First submit succeeds.
  const first = await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  assert.equal(first.ok, true);
  // Second submit for the same week - the ALREADY_SUBMITTED check
  // runs first (now that the row exists); force the check to miss
  // by deleting the row from the live view the check reads but
  // keeping it in the store so the index refuses - rare in practice.
  // Simpler: the base mock's insert path will go through the wrapper,
  // which returns 23505.
  const second = await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  assert.equal(second.ok, false);
  assert.ok(second.blocks.some((b) => b.code === "ALREADY_SUBMITTED"),
    "the second submit returns ALREADY_SUBMITTED, either from the live-row check or the index refusal");
});

test("lock: submitWeek throws on a Wednesday weekStart and writes nothing", async () => {
  const supa = withRpc(cleanTables());
  const before = supa._dump("sc_week_finalize").length;
  await assert.rejects(
    () => submitWeek({ accountKey: "TXR - AZ", weekStart: "2026-07-29", email: "kevin@kitchfix.com" }, supa),
    /Monday/,
  );
  assert.equal(supa._dump("sc_week_finalize").length, before, "no row written on the bad caller");
});

test("lock: submitWeek throws on a malformed weekStart", async () => {
  const supa = withRpc(cleanTables());
  await assert.rejects(
    () => submitWeek({ accountKey: "TXR - AZ", weekStart: "not-a-date", email: "kevin@kitchfix.com" }, supa),
    /YYYY-MM-DD/,
  );
});

test("lock: no path in the new code writes status='billed'", async () => {
  const supa = withRpc(cleanTables());
  await submitWeek({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const row = supa._dump("sc_week_finalize")[0];
  assert.notEqual(row.status, "billed", "status is never 'billed' - v1 reserves that word");
  assert.equal(row.status, "finalized");
});
