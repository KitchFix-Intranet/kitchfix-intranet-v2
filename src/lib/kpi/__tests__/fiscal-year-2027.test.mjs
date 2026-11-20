// Train 2c: the labor + purchasing entries take `fiscalYear` as an
// input - the engine does not guess a year from today's date. This
// test builds a made-up FY2027 (28-day periods back to back, P1
// starts on a Monday, same 13-period shape v1 ships for every year)
// and confirms:
//
//   1. Both getLabor + getPurchasing accept FY2027 without crashing
//      and surface its boundaries in the response body.
//   2. The same process can serve FY2026 and FY2027 back-to-back (and
//      interleaved) without either year's data leaking into the other
//      - P1 startISO in the 2026 response differs from P1 startISO in
//      the 2027 response, which is the simplest defeat-condition for a
//      module-level FY cache.
//
// Made-up data only. The stub supa returns empty rows for every query;
// any figure asserted is a boundary date that comes from the FY object
// itself, never a real-world dollar.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLabor, getPurchasing } from "../entry.js";
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

// Made-up FY2027: starts the day after FY2026 ends (also a Monday),
// 28-day periods back-to-back, 13 periods total. Byte-identical shape
// to v1's typed-in constants, anchored at a new start.
const FY2027 = buildFiscalYear(2027, [
  { period_no: 1,  start_date: "2026-12-28", end_date: "2027-01-24" },
  { period_no: 2,  start_date: "2027-01-25", end_date: "2027-02-21" },
  { period_no: 3,  start_date: "2027-02-22", end_date: "2027-03-21" },
  { period_no: 4,  start_date: "2027-03-22", end_date: "2027-04-18" },
  { period_no: 5,  start_date: "2027-04-19", end_date: "2027-05-16" },
  { period_no: 6,  start_date: "2027-05-17", end_date: "2027-06-13" },
  { period_no: 7,  start_date: "2027-06-14", end_date: "2027-07-11" },
  { period_no: 8,  start_date: "2027-07-12", end_date: "2027-08-08" },
  { period_no: 9,  start_date: "2027-08-09", end_date: "2027-09-05" },
  { period_no: 10, start_date: "2027-09-06", end_date: "2027-10-03" },
  { period_no: 11, start_date: "2027-10-04", end_date: "2027-10-31" },
  { period_no: 12, start_date: "2027-11-01", end_date: "2027-11-28" },
  { period_no: 13, start_date: "2027-11-29", end_date: "2027-12-26" },
]);

// Empty-data chainable supa stub. Every chain method - including the
// "terminals" like .range / .limit / .maybeSingle / .single - returns
// the builder itself so a caller can keep chaining (real
// @supabase/supabase-js builders are thenables that accept .eq / .like
// / etc after .range). Awaiting the builder (`await builder`) resolves
// `{ data: [], error: null }`. .maybeSingle() / .single() set the
// thenable to resolve `{ data: null, error: null }` instead.
function emptySupa() {
  const makeBuilder = () => {
    const builder = {};
    const noop = () => builder;
    let resolvedValue = { data: [], error: null };
    for (const m of [
      "select", "eq", "neq", "in", "gte", "lte", "lt", "gt",
      "order", "not", "or", "filter", "ilike", "like", "is", "match",
      "limit", "range",
    ]) builder[m] = noop;
    builder.maybeSingle = () => {
      resolvedValue = { data: null, error: null };
      return builder;
    };
    builder.single = builder.maybeSingle;
    builder.then = (resolve, reject) =>
      Promise.resolve(resolvedValue).then(resolve, reject);
    return builder;
  };
  return {
    from() { return makeBuilder(); },
    rpc() { return makeBuilder(); },
  };
}

const corporate = { role: "corporate", scope: null, can_see_salary: true };

describe("getLabor accepts a made-up FY2027", () => {
  it("empty-account landing response succeeds under FY2027 (no FY guess, no crash)", async () => {
    const res = await getLabor({
      supa: emptySupa(),
      today: "2027-06-15",
      now: new Date("2027-06-15T10:00:00Z"),
      fiscalYear: FY2027,
      caller: corporate,
      query: {},
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.landing_account !== undefined, "landing_account present");
    assert.ok(Array.isArray(res.body.accounts_directory), "accounts_directory array");
  });

  it("D26 salaried-only account under FY2027 echoes the range from FY2027 bounds", async () => {
    // Start/end default from the FY object: start=fy.startISO, end=today.
    // CIN - KY is D26 salaried-only and triggers a dedicated body with
    // `filters: { account, start, end }` that comes straight from the
    // FY input.
    const res = await getLabor({
      supa: emptySupa(),
      today: "2027-06-15",
      now: new Date("2027-06-15T10:00:00Z"),
      fiscalYear: FY2027,
      caller: corporate,
      query: { account: "CIN - KY" },
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.account_state, "salaried_only");
    assert.strictEqual(res.body.filters.start, FY2027.startISO);
    assert.strictEqual(res.body.filters.start, "2026-12-28");
    assert.strictEqual(res.body.todayISO, "2027-06-15");
  });
});

describe("getPurchasing accepts a made-up FY2027", () => {
  it("no-account response echoes todayISO (FY2027 accepted, no crash)", async () => {
    const res = await getPurchasing({
      supa: emptySupa(),
      today: "2027-06-15",
      now: new Date("2027-06-15T10:00:00Z"),
      fiscalYear: FY2027,
      caller: corporate,
      query: {},
      feeGoals: {},
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "account_required");
    assert.strictEqual(res.body.todayISO, "2027-06-15");
  });
});

describe("FY2026 and FY2027 interleaved never contaminate each other", () => {
  it("getLabor D26 start differs between FY2026 and FY2027 on the same process", async () => {
    const supa = emptySupa();
    const commonArgs = {
      supa, caller: corporate,
      query: { account: "CIN - KY" },
      regionalDirectorEastDisplay: null,
      regionalDirectorWestDisplay: null,
    };
    // Note: the D26 body's `filters.start` is the FY's startISO by
    // default. A shared FY cache would make these two equal; this
    // assertion is the fence.
    const res26 = await getLabor({
      ...commonArgs,
      today: "2026-11-17",
      now: new Date("2026-11-17T14:00:00Z"),
      fiscalYear: FY2026,
    });
    const res27 = await getLabor({
      ...commonArgs,
      today: "2027-06-15",
      now: new Date("2027-06-15T10:00:00Z"),
      fiscalYear: FY2027,
    });
    assert.strictEqual(res26.body.filters.start, "2025-12-29");
    assert.strictEqual(res27.body.filters.start, "2026-12-28");
    assert.notStrictEqual(res26.body.filters.start, res27.body.filters.start);
    assert.strictEqual(res26.body.todayISO, "2026-11-17");
    assert.strictEqual(res27.body.todayISO, "2027-06-15");
  });

  it("getPurchasing todayISO follows each call's own today input", async () => {
    const supa = emptySupa();
    const res26 = await getPurchasing({
      supa, caller: corporate, query: {}, feeGoals: {},
      today: "2026-11-17",
      now: new Date("2026-11-17T14:00:00Z"),
      fiscalYear: FY2026,
    });
    const res27 = await getPurchasing({
      supa, caller: corporate, query: {}, feeGoals: {},
      today: "2027-06-15",
      now: new Date("2027-06-15T10:00:00Z"),
      fiscalYear: FY2027,
    });
    assert.strictEqual(res26.body.todayISO, "2026-11-17");
    assert.strictEqual(res27.body.todayISO, "2027-06-15");
    assert.notStrictEqual(res26.body.todayISO, res27.body.todayISO);
  });

  it("interleaved calls preserve each caller's fiscal year", async () => {
    // Twenty parallel calls alternating years; each must return its
    // own year's startISO. Module-level FY state would show up as
    // cross-talk here. The empty-data stub keeps this test purely
    // about the FY input plumbing.
    const supa = emptySupa();
    const tasks = [];
    for (let i = 0; i < 20; i += 1) {
      const fy = i % 2 === 0 ? FY2026 : FY2027;
      const expectStart = i % 2 === 0 ? "2025-12-29" : "2026-12-28";
      const today = i % 2 === 0 ? "2026-11-17" : "2027-06-15";
      tasks.push((async () => {
        const res = await getLabor({
          supa, caller: corporate,
          query: { account: "CIN - KY" },
          today, now: new Date(`${today}T10:00:00Z`),
          fiscalYear: fy,
          regionalDirectorEastDisplay: null,
          regionalDirectorWestDisplay: null,
        });
        assert.strictEqual(res.body.filters.start, expectStart,
          `iteration ${i}: FY${fy.year} should start ${expectStart}`);
      })());
    }
    await Promise.all(tasks);
  });
});
