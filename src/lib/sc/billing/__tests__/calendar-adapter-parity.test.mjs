// resolveFinalizeReviewSpan through makeInScopeAdapter must return
// the same answer as through the existing test mock, for every week
// shape in play:
//   - weekly site
//   - biweekly week index 1
//   - biweekly week index 2
//   - biweekly week index 3
//   - biweekly week index 4
//   - biweekly with no week_label (defensive first-week path)
//
// If the engine helper's reads ever change, this test fails LOUDLY
// through the adapter's "unexpected call shape" throws.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveFinalizeReviewSpan } from "../../scWeekFinalize.ts";
import { makeInScopeAdapter } from "../../calendar/inScopeAdapter.ts";
import { makeSupaMock } from "./_supa-mock.mjs";

function baseTables(cadence, weekLabelByDate) {
  return {
    sc_qbo_account_map: [{ account_key: "ACME", cadence }],
    sc_day_metadata: Object.entries(weekLabelByDate).map(([service_date, week_label]) => ({
      account_key: "ACME",
      service_date,
      week_label,
    })),
  };
}

async function runBoth(cadence, weekLabelByDate, weekStart) {
  const mock = makeSupaMock({ tables: baseTables(cadence, weekLabelByDate) });
  const adapter = makeInScopeAdapter({
    accountKey: "ACME",
    cadence: cadence,
    weekLabelByDate: new Map(Object.entries(weekLabelByDate)),
  });
  const viaMock = await resolveFinalizeReviewSpan("ACME", weekStart, mock);
  const viaAdapter = await resolveFinalizeReviewSpan("ACME", weekStart, adapter);
  return { viaMock, viaAdapter };
}

test("adapter parity: weekly site, span is always 7 days", async () => {
  const { viaMock, viaAdapter } = await runBoth("weekly", {}, "2026-11-02");
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 7);
  assert.equal(viaAdapter.isBiweekly, false);
});

test("adapter parity: biweekly, week index 1 is a 7-day defensive span", async () => {
  const { viaMock, viaAdapter } = await runBoth(
    "biweekly",
    { "2026-11-02": "Week 1" },
    "2026-11-02",
  );
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 7);
  assert.equal(viaAdapter.weekIndex, 1);
});

test("adapter parity: biweekly, week index 2 is the 14-day close-week pair", async () => {
  const { viaMock, viaAdapter } = await runBoth(
    "biweekly",
    { "2026-11-09": "Week 2" },
    "2026-11-09",
  );
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 14);
  assert.equal(viaAdapter.weekIndex, 2);
  assert.equal(viaAdapter.spanStart, "2026-11-02");
});

test("adapter parity: biweekly, week index 3 is a 7-day defensive span", async () => {
  const { viaMock, viaAdapter } = await runBoth(
    "biweekly",
    { "2026-11-16": "Week 3" },
    "2026-11-16",
  );
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 7);
  assert.equal(viaAdapter.weekIndex, 3);
});

test("adapter parity: biweekly, week index 4 is the 14-day close-week pair", async () => {
  const { viaMock, viaAdapter } = await runBoth(
    "biweekly",
    { "2026-11-23": "Week 4" },
    "2026-11-23",
  );
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 14);
  assert.equal(viaAdapter.weekIndex, 4);
  assert.equal(viaAdapter.spanStart, "2026-11-16");
});

test("adapter parity: biweekly with no label falls back to a 7-day own-week span", async () => {
  const { viaMock, viaAdapter } = await runBoth("biweekly", {}, "2026-11-02");
  assert.deepEqual(viaAdapter, viaMock);
  assert.equal(viaAdapter.dates.length, 7);
  assert.equal(viaAdapter.weekIndex, null);
});

test("adapter: an unexpected select call shape throws", () => {
  const adapter = makeInScopeAdapter({
    accountKey: "ACME",
    cadence: "weekly",
    weekLabelByDate: new Map(),
  });
  // Deliberately drive the adapter through a shape the engine does not
  // use. The adapter throws synchronously at select() time.
  assert.throws(
    () => adapter.from("sc_qbo_account_map").select("active"),
    /engine helper changed shape|select expected/,
  );
});
