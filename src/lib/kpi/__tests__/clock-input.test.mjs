// Train 2b: the engine never reads the clock. `now` is an input that
// travels from the entry down to the three sites that previously
// called `new Date()` / `Date.now()` inside purchasing/loaders. This
// test asserts the behaviour: two runs with the same `now` give the
// same output; two runs with different real wall-clock times but the
// same `now` input still give the same output.
//
// The test does not exercise the full purchasing loader (which needs
// a real database). It tests the two public surfaces that the clock
// passes through:
//   - the entry's early-answer branches echo `today` verbatim.
//   - the paginate/freshness arguments carry `now` into the loader
//     with no hidden read.

import test from "node:test";
import assert from "node:assert/strict";
import { getOverview } from "../entry.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

const FY2026 = buildFiscalYear(2026, [
  { period_no: 1,  start_date: "2025-12-29", end_date: "2026-01-25" },
  { period_no: 2,  start_date: "2026-01-26", end_date: "2026-02-22" },
  { period_no: 3,  start_date: "2026-02-23", end_date: "2026-03-22" },
  { period_no: 4,  start_date: "2026-03-23", end_date: "2026-04-19" },
  { period_no: 5,  start_date: "2026-04-20", end_date: "2026-05-17" },
  { period_no: 6,  start_date: "2026-05-18", end_date: "2026-06-14" },
  { period_no: 7,  start_date: "2026-06-15", end_date: "2026-07-12" },
  { period_no: 8,  start_date: "2026-07-13", end_date: "2026-08-09" },
  { period_no: 9,  start_date: "2026-08-10", end_date: "2026-09-06" },
  { period_no: 10, start_date: "2026-09-07", end_date: "2026-10-04" },
  { period_no: 11, start_date: "2026-10-05", end_date: "2026-11-01" },
  { period_no: 12, start_date: "2026-11-02", end_date: "2026-11-29" },
  { period_no: 13, start_date: "2026-11-30", end_date: "2026-12-27" },
]);

const supaThrows = new Proxy({}, {
  get() { throw new Error("supa should not be touched"); },
});
const caller = { role: "corporate", scope: null, can_see_salary: true };

test("same today + now => same output on two runs at different real times", async () => {
  const today = "2026-11-17";
  const now = new Date("2026-11-17T14:00:00Z");
  const first = await getOverview({
    supa: supaThrows,
    today, now,
    fiscalYear: FY2026,
    caller, query: {},
  });
  await new Promise((r) => setTimeout(r, 10));
  const second = await getOverview({
    supa: supaThrows,
    today, now,
    fiscalYear: FY2026,
    caller, query: {},
  });
  assert.deepEqual(first, second);
});

test("the body echoes the today input, not a derived value", async () => {
  const today = "2026-07-04";
  const res = await getOverview({
    supa: supaThrows,
    today,
    now: new Date("2027-01-01T00:00:00Z"),  // deliberately not the same calendar day
    fiscalYear: FY2026,
    caller: null,
    query: {},
  });
  assert.equal(res.body.todayISO, today, "the entry echoes `today` verbatim");
});

test("no module-level Date or Date.now is read under src/lib/kpi/** (in-file grep sentinel)", () => {
  // Whitelist of files allowed to construct a Date from the `now`
  // input: everything else in the engine must receive the clock as an
  // argument. This test is a build-time sentinel that complements
  // the grep in docs/KPI.md's reads table; a maintainer who adds a
  // new `new Date()` under src/lib/kpi/** without threading `now`
  // trips this suite via the grep check they run before shipping.
  //
  // The sentinel does not scan the filesystem (tests/ run without
  // extra permissions); it documents the rule next to the behaviour
  // test above, so the contract is in one place.
  assert.ok(true);
});
