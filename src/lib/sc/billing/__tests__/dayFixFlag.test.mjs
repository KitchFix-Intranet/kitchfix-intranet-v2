// dayFixFlag (round 3): the write core for /api/service/day-fix-flag.
//
// Four cases Kevin pinned:
//   1. No row  -> NO_DAY_RECORD, nothing written
//   2. Closed period -> PERIOD_LOCKED, nothing written
//   3. Submitted week -> WEEK_FINALIZED, nothing written
//   4. Happy path -> ok, review_status='flagged' on the existing row

import test from "node:test";
import assert from "node:assert/strict";
import { flagDayForFix, clearDayFix } from "../../submit/dayFixFlag.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

const AK = "ACCT-A - YY";
const ISO = "2026-07-22";   // Wednesday
const MON = "2026-07-20";
const EMAIL = "leader@kitchfix.com";

function tables(overrides = {}) {
  return {
    people: [],            // not an override holder
    sc_qbo_account_map: [{ account_key: AK, cadence: "weekly", qbo_mode: "test" }],
    sc_day_metadata: [],
    sc_week_finalize: [],
    ...overrides,
  };
}

function withRpc(mock, { locked = false } = {}) {
  const base = mock._base ? mock._base() : mock;
  const origRpc = base.rpc?.bind(base);
  mock.rpc = (name, args) => {
    if (name === "sc_is_day_locked") return Promise.resolve({ data: locked, error: null });
    return origRpc ? origRpc(name, args) : Promise.resolve({ data: null, error: null });
  };
  return mock;
}

test("dayFixFlag case 1: no row for the day -> NO_DAY_RECORD, nothing created", async () => {
  const supa = withRpc(makeSupaMock({ tables: tables() }));
  const out = await flagDayForFix(supa, { accountKey: AK, iso: ISO, email: EMAIL });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NO_DAY_RECORD");
  const rows = supa._dump("sc_day_metadata");
  assert.equal(rows.length, 0, "no row was created - the record stays untouched");
});

test("dayFixFlag case 2: closed period -> PERIOD_LOCKED, nothing written", async () => {
  const supa = withRpc(
    makeSupaMock({
      tables: tables({
        sc_day_metadata: [{ account_key: AK, service_date: ISO, review_status: null, period: "7", week_label: "Week 1" }],
      }),
    }),
    { locked: true },
  );
  const out = await flagDayForFix(supa, { accountKey: AK, iso: ISO, email: EMAIL });
  assert.equal(out.ok, false);
  assert.equal(out.code, "PERIOD_LOCKED");
  const row = supa._dump("sc_day_metadata").find((r) => r.service_date === ISO);
  assert.equal(row.review_status, null, "flag was not written on a closed period");
});

test("dayFixFlag case 3: submitted week -> WEEK_FINALIZED, nothing written", async () => {
  const supa = withRpc(
    makeSupaMock({
      tables: tables({
        sc_day_metadata: [{ account_key: AK, service_date: ISO, review_status: null, period: "7", week_label: "Week 1" }],
        sc_week_finalize: [{
          id: "fin-1", account_key: AK, week_start: MON, status: "finalized",
        }],
      }),
    }),
  );
  const out = await flagDayForFix(supa, { accountKey: AK, iso: ISO, email: EMAIL });
  assert.equal(out.ok, false);
  assert.equal(out.code, "WEEK_FINALIZED");
  const row = supa._dump("sc_day_metadata").find((r) => r.service_date === ISO);
  assert.equal(row.review_status, null, "flag was not written on a submitted week");
});

test("dayFixFlag case 4: happy path -> flagged on the existing row", async () => {
  const supa = withRpc(
    makeSupaMock({
      tables: tables({
        sc_day_metadata: [{ account_key: AK, service_date: ISO, review_status: null, period: "7", week_label: "Week 1" }],
      }),
    }),
  );
  const out = await flagDayForFix(supa, { accountKey: AK, iso: ISO, email: EMAIL });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "flagged");
  const row = supa._dump("sc_day_metadata").find((r) => r.service_date === ISO);
  assert.equal(row.review_status, "flagged");
  assert.equal(row.reviewed_by, EMAIL);
  assert.ok(row.reviewed_at, "reviewed_at is set");
});

test("dayFixFlag clear happy path: a flagged day clears back to null", async () => {
  const supa = withRpc(
    makeSupaMock({
      tables: tables({
        sc_day_metadata: [{
          account_key: AK, service_date: ISO,
          review_status: "flagged", reviewed_by: EMAIL, reviewed_at: "2026-07-22T18:00:00Z",
          period: "7", week_label: "Week 1",
        }],
      }),
    }),
  );
  const out = await clearDayFix(supa, { accountKey: AK, iso: ISO, email: EMAIL });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "cleared");
  assert.equal(out.cleared, 1);
  const row = supa._dump("sc_day_metadata").find((r) => r.service_date === ISO);
  assert.equal(row.review_status, null);
  assert.equal(row.reviewed_by, null);
  assert.equal(row.reviewed_at, null);
});
