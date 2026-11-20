// Entry early-answer tests. The entry has three branches that return
// before any database read: no account given, CORP refusal, and the
// not-authorised locked-state answer. Each lives entirely inside the
// entry's own logic (calls canViewAccount + canSeeSalary from the
// moved roleGate, nothing else).
//
// supa is a stub that throws if called - the test asserts the three
// early-answer branches never reach it.
//
// Train 2b: the entry takes `now` and a loaded `fiscalYear` as inputs.
// The early branches never touch either, but both are required
// arguments; the test passes a made-up FY2026 (byte-identical to the
// table) and a fixed `now` so the file still runs with no DB and no
// clock reads.

import test from "node:test";
import assert from "node:assert/strict";
import { getOverview } from "../entry.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

const supaThrows = new Proxy({}, {
  get() { throw new Error("supa should not be touched in early-answer tests"); },
});

const TODAY = "2026-11-17";
const NOW = new Date("2026-11-17T12:00:00Z");
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
const corporate = { role: "corporate", scope: null, can_see_salary: true };
const siteLeader = { role: "site_leader", scope: "TBR - FL" };

test("no account -> landing response", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
    now: NOW,
    fiscalYear: FY2026,
    caller: corporate,
    query: {},
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    landing_account: "ALL",
    preview_account: null,
    todayISO: TODAY,
  });
});

test("CORP -> account_out_of_scope", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
    now: NOW,
    fiscalYear: FY2026,
    caller: corporate,
    query: { account: "CORP" },
  });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(res.body, { error: "account_out_of_scope", account: "CORP" });
});

test("not authorised -> locked-state answer (site_leader on another account)", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
    now: NOW,
    fiscalYear: FY2026,
    caller: siteLeader,
    query: { account: "CIN - AZ" },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    locked: true,
    account: "CIN - AZ",
    reason: "not_authorised",
    landing_account: "TBR - FL",
    preview_account: null,
    todayISO: TODAY,
  });
});

test("not authorised -> locked-state answer (site_leader on ALL aggregate)", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
    now: NOW,
    fiscalYear: FY2026,
    caller: siteLeader,
    query: { account: "ALL" },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.locked, true);
  assert.strictEqual(res.body.reason, "not_authorised");
});

test("null caller + no account still returns landing answer with null landing", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
    now: NOW,
    fiscalYear: FY2026,
    caller: null,
    query: {},
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.landing_account, null);
});
