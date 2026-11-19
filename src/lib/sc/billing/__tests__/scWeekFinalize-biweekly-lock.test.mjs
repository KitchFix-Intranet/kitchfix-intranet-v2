// Gap A: assertWeekOpenForWrite + biweekly pair locks.
//
// Shape: on a biweekly account, the sc_week_finalize row for a
// submitted pair is keyed on the CLOSING week's Monday (Week 2 or
// Week 4). Before this fix, assertWeekOpenForWrite only looked up
// mondayOfWeek(d) and missed the pair's lock when the write targeted
// the FIRST week (Week 1 or 3). This allowed a day-write on an
// already-submitted pair's first week to slip past the guard.
//
// Four cases:
//   1. Biweekly, write on Week 1 date, pair submitted -> WEEK_FINALIZED
//   2. Biweekly, write on Week 2 date, pair submitted -> WEEK_FINALIZED
//   3. Biweekly, write on Week 1 date, pair NOT submitted -> null
//   4. Weekly, write on same date, no row -> null (unchanged shape)
//
// The engine's optional `supaArg` is used; call sites do not need to
// change.

import test from "node:test";
import assert from "node:assert/strict";
import { assertWeekOpenForWrite } from "../../scWeekFinalize.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

const AK = "ACCT-A - YY";
const OPEN_MON  = "2026-07-20"; // week 1
const CLOSE_MON = "2026-07-27"; // week 2
const OPEN_WED  = "2026-07-22"; // a day inside week 1

function biweeklyTables(overrides = {}) {
  return {
    sc_qbo_account_map: [{ account_key: AK, cadence: "biweekly", qbo_mode: "test" }],
    sc_day_metadata: [
      { account_key: AK, service_date: OPEN_MON,  week_label: "Week 1" },
      { account_key: AK, service_date: CLOSE_MON, week_label: "Week 2" },
    ],
    sc_week_finalize: [],
    ...overrides,
  };
}

test("Gap A: biweekly pair locks week 1 when the pair is submitted (CLOSE_MON row)", async () => {
  const supa = makeSupaMock({
    tables: biweeklyTables({
      sc_week_finalize: [{
        id: "fin-1",
        account_key: AK,
        week_start: CLOSE_MON,  // biweekly key is the closing Monday
        status: "finalized",
      }],
    }),
  });
  const out = await assertWeekOpenForWrite(AK, [OPEN_WED], null, supa);
  assert.ok(out, "expected WEEK_FINALIZED");
  assert.equal(out.code, "WEEK_FINALIZED");
  assert.equal(out.finalizedWeeks.length, 1);
  // Message names the WRITE's week (OPEN_MON), not the finalize row's key.
  assert.equal(out.finalizedWeeks[0].weekStart, OPEN_MON);
  assert.equal(out.finalizedWeeks[0].status, "finalized");
});

test("Gap A: biweekly pair locks week 2 too (same row, same key)", async () => {
  const supa = makeSupaMock({
    tables: biweeklyTables({
      sc_week_finalize: [{
        id: "fin-1",
        account_key: AK,
        week_start: CLOSE_MON,
        status: "finalized",
      }],
    }),
  });
  const CLOSE_WED = "2026-07-29";
  const out = await assertWeekOpenForWrite(AK, [CLOSE_WED], null, supa);
  assert.ok(out, "expected WEEK_FINALIZED");
  assert.equal(out.finalizedWeeks[0].weekStart, CLOSE_MON);
});

test("Gap A: biweekly week 1 write with no finalize row returns null", async () => {
  const supa = makeSupaMock({ tables: biweeklyTables() });
  const out = await assertWeekOpenForWrite(AK, [OPEN_WED], null, supa);
  assert.equal(out, null);
});

test("Gap A: weekly account with no finalize row returns null (unchanged shape)", async () => {
  const supa = makeSupaMock({
    tables: {
      sc_qbo_account_map: [{ account_key: AK, cadence: "weekly", qbo_mode: "test" }],
      sc_day_metadata: [],
      sc_week_finalize: [],
    },
  });
  const out = await assertWeekOpenForWrite(AK, [OPEN_WED], null, supa);
  assert.equal(out, null);
});

test("Gap A: biweekly, reverted pair row does NOT lock (status=reverted ignored)", async () => {
  const supa = makeSupaMock({
    tables: biweeklyTables({
      sc_week_finalize: [{
        id: "fin-1",
        account_key: AK,
        week_start: CLOSE_MON,
        status: "reverted",
      }],
    }),
  });
  const out = await assertWeekOpenForWrite(AK, [OPEN_WED], null, supa);
  assert.equal(out, null);
});
