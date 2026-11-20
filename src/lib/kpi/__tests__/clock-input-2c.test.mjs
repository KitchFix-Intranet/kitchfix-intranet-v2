// Train 2c: `today` + `now` are inputs to getLabor + getPurchasing.
// The engine never reads the wall clock; the entry passes both values
// down to every helper that needs "the current moment." This file
// extends the existing clock-input.test.mjs (which covers getOverview)
// to the two new entries and asserts three things:
//
//   1. The response echoes the `today` input verbatim (no derivation
//      from the real wall clock).
//   2. Two calls with different `today` + `now` inputs return
//      different todayISO values.
//   3. Before AND after the two calls, `new Date().toISOString()`
//      still reflects the real wall clock - i.e. the engine did not
//      somehow move the machine's clock.
//   4. A mismatched `today` / `now` pair (ISO date doesn't match
//      timestamp's calendar day) does not crash the engine.
//
// Made-up data only; the stub supa returns empty for every read.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLabor, getPurchasing, getOverview } from "../entry.js";
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

function emptySupa() {
  const makeBuilder = () => {
    const b = {};
    const noop = () => b;
    let resolvedValue = { data: [], error: null };
    for (const m of [
      "select", "eq", "neq", "in", "gte", "lte", "lt", "gt",
      "order", "not", "or", "filter", "ilike", "like", "is", "match",
      "limit", "range",
    ]) b[m] = noop;
    b.maybeSingle = () => { resolvedValue = { data: null, error: null }; return b; };
    b.single = b.maybeSingle;
    b.then = (resolve, reject) =>
      Promise.resolve(resolvedValue).then(resolve, reject);
    return b;
  };
  return {
    from() { return makeBuilder(); },
    rpc() { return makeBuilder(); },
  };
}

const corporate = { role: "corporate", scope: null, can_see_salary: true };

describe("getLabor / getPurchasing follow the `today` input, not the wall clock", () => {
  it("getLabor D26 echoes today verbatim for 2026-03-15", async () => {
    const today = "2026-03-15";
    const now = new Date("2026-03-15T10:00:00Z");
    const res = await getLabor({
      supa: emptySupa(),
      today, now,
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - KY" },  // D26 salaried-only, exits with filters + todayISO
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    assert.strictEqual(res.body.todayISO, today);
    assert.strictEqual(res.body.filters.end, today, "end defaults to today input");
  });

  it("getLabor D26 moves to 2026-07-20 when today moves", async () => {
    const today = "2026-07-20";
    const now = new Date("2026-07-20T10:00:00Z");
    const res = await getLabor({
      supa: emptySupa(),
      today, now,
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - KY" },
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    assert.strictEqual(res.body.todayISO, today);
    assert.strictEqual(res.body.filters.end, today);
  });

  it("getPurchasing echoes today for 2026-03-15 and again for 2026-07-20", async () => {
    const supa = emptySupa();
    const r1 = await getPurchasing({
      supa, caller: corporate, query: {}, feeGoals: {},
      today: "2026-03-15",
      now: new Date("2026-03-15T10:00:00Z"),
      fiscalYear: FY2026,
    });
    const r2 = await getPurchasing({
      supa, caller: corporate, query: {}, feeGoals: {},
      today: "2026-07-20",
      now: new Date("2026-07-20T10:00:00Z"),
      fiscalYear: FY2026,
    });
    assert.strictEqual(r1.body.todayISO, "2026-03-15");
    assert.strictEqual(r2.body.todayISO, "2026-07-20");
    assert.notStrictEqual(r1.body.todayISO, r2.body.todayISO);
  });
});

describe("machine wall clock is untouched by the engine", () => {
  it("before + after two getLabor calls, new Date() still reflects real wall clock", async () => {
    const wallBefore = new Date().toISOString();
    // Two full calls with a made-up `now` far from the real moment.
    // If the engine ever reassigned `Date.now` or installed a sinon-
    // style clock, `wallAfter` would land on the made-up timestamp
    // rather than real time.
    await getLabor({
      supa: emptySupa(),
      today: "2026-03-15",
      now: new Date("2026-03-15T10:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - KY" },
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    await getPurchasing({
      supa: emptySupa(),
      caller: corporate, query: {}, feeGoals: {},
      today: "2027-12-01",
      now: new Date("2027-12-01T10:00:00Z"),
      fiscalYear: FY2026,
    });
    const wallAfter = new Date().toISOString();
    // Both wall samples fall in the same real-world year (today > 2024,
    // < 2050). The made-up `now` values deliberately straddle year
    // boundaries the real clock will not hit during the test run.
    const yearBefore = Number(wallBefore.slice(0, 4));
    const yearAfter = Number(wallAfter.slice(0, 4));
    assert.ok(yearBefore >= 2024 && yearBefore <= 2050,
      `wall clock before (${wallBefore}) is in a plausible real year`);
    assert.ok(yearAfter >= 2024 && yearAfter <= 2050,
      `wall clock after (${wallAfter}) is in a plausible real year`);
    // Both reads are close to each other (within 60 seconds).
    const dt = new Date(wallAfter).getTime() - new Date(wallBefore).getTime();
    assert.ok(dt >= 0 && dt < 60_000,
      `wall clock did not move backward or skip (delta ${dt}ms)`);
  });
});

describe("mismatched today / now does not crash the entries", () => {
  it("getOverview with mismatched inputs returns a consistent response shape", async () => {
    const res = await getOverview({
      supa: emptySupa(),
      today: "2026-07-04",
      now: new Date("2027-01-01T00:00:00Z"),  // deliberately off from today
      fiscalYear: FY2026,
      caller: null,
      query: {},
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.todayISO, "2026-07-04", "today still echoed verbatim");
  });

  it("getPurchasing with mismatched inputs still returns a well-formed shape", async () => {
    const res = await getPurchasing({
      supa: emptySupa(),
      today: "2026-07-04",
      now: new Date("2027-01-01T00:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: {},
      feeGoals: {},
    });
    assert.ok(res.status === 400 || res.status === 200,
      `status is a known shape, got ${res.status}`);
    assert.strictEqual(res.body.todayISO, "2026-07-04");
  });

  it("getLabor with mismatched inputs returns a well-formed D26 shape", async () => {
    const res = await getLabor({
      supa: emptySupa(),
      today: "2026-07-04",
      now: new Date("2027-01-01T00:00:00Z"),
      fiscalYear: FY2026,
      caller: corporate,
      query: { account: "CIN - KY" },
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.todayISO, "2026-07-04");
  });
});
