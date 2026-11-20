// Train 2b: every read under src/lib/kpi/** flows through pagedSelect,
// and every paged read sorts on a unique key. This test runs a
// hand-rolled stand-in database that holds more than 2,000 rows with
// several rows sharing one sort value and returns them 1,000 at a
// time. A correct paged read returns every row once; a non-unique
// sort would drop or duplicate rows at the 1,000-row boundary.
//
// Modelled on src/lib/sc/billing/__tests__/calendar-load-paging.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { pagedSelect } from "../shared/pagedSelect.js";

function makeRows(n, sharedKey = "txn_date") {
  // Generate n rows across k distinct dates (each date has 20 rows).
  // Sorting only on `txn_date` would leave ties at every date.
  const rows = [];
  const perDate = 20;
  const nDates = Math.ceil(n / perDate);
  for (let d = 0; d < nDates; d += 1) {
    const dt = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    for (let i = 0; i < perDate && rows.length < n; i += 1) {
      rows.push({
        id: rows.length + 1,         // globally unique
        [sharedKey]: dt,              // 20 rows share this value
        amount: (rows.length + 1) * 1.1,
      });
    }
  }
  return rows;
}

// A minimal PostgREST-shaped builder. Every call to .order / .select /
// .range returns the same builder; range pulls a slice of the sorted
// view. Sort uses either the single key or the pair.
function makeBuilder(rows, sortKeys) {
  // Pre-sort by the chain.
  const sorted = [...rows].sort((a, b) => {
    for (const k of sortKeys) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  });
  const builder = {
    select() { return builder; },
    order() { return builder; },
    range(lo, hi) {
      return Promise.resolve({
        data: sorted.slice(lo, hi + 1),
        error: null,
      });
    },
    then(resolve) { return resolve({ data: sorted, error: null }); },
  };
  return builder;
}

test("pagedSelect walks every page under a unique sort", async () => {
  const rows = makeRows(2340);
  const builder = makeBuilder(rows, ["txn_date", "id"]);
  const r = await pagedSelect((lo, hi) => builder.select().order().order().range(lo, hi));
  assert.equal(r.error, undefined);
  assert.equal(r.data.length, 2340, "every row lands");
  // Every id present exactly once.
  const ids = new Set(r.data.map((x) => x.id));
  assert.equal(ids.size, 2340);
});

test("pagedSelect returns an empty page without a short-page error", async () => {
  const rows = [];
  const builder = makeBuilder(rows, ["id"]);
  const r = await pagedSelect((lo, hi) => builder.select().order().range(lo, hi));
  assert.deepEqual(r.data, []);
  assert.equal(r.error, undefined);
});

test("short first page stops the walk - no runaway call", async () => {
  const rows = makeRows(42);
  let calls = 0;
  const builder = makeBuilder(rows, ["txn_date", "id"]);
  const wrapped = (lo, hi) => { calls += 1; return builder.select().order().order().range(lo, hi); };
  const r = await pagedSelect(wrapped);
  assert.equal(r.data.length, 42);
  assert.equal(calls, 1, "one call is enough on a short page");
});

test("page boundary with ties - a unique sort returns every row once", async () => {
  // 2050 rows across 103 dates, 20 per date. The 1,000-row cut lands
  // inside a group of 20 rows sharing one date. A sort on (txn_date)
  // alone would be ambiguous at the boundary; (txn_date, id) is not.
  const rows = makeRows(2050);
  const builder = makeBuilder(rows, ["txn_date", "id"]);
  const r = await pagedSelect((lo, hi) => builder.select().order().order().range(lo, hi));
  const ids = r.data.map((x) => x.id).sort((a, b) => a - b);
  assert.equal(ids.length, 2050);
  for (let i = 0; i < 2050; i += 1) {
    assert.equal(ids[i], i + 1, `row ${i + 1} present once`);
  }
});

test("page size override honoured", async () => {
  const rows = makeRows(600);
  const builder = makeBuilder(rows, ["id"]);
  let calls = 0;
  const wrapped = (lo, hi) => {
    calls += 1;
    return builder.select().order().range(lo, hi);
  };
  const r = await pagedSelect(wrapped, { pageSize: 250 });
  assert.equal(r.data.length, 600);
  // 250 + 250 + 100 = 3 calls, last page short.
  assert.equal(calls, 3);
});
