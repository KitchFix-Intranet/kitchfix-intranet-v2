// Entry early-answer tests. The entry has three branches that return
// before any database read: no account given, CORP refusal, and the
// not-authorised locked-state answer. Each lives entirely inside the
// entry's own logic (calls canViewAccount + canSeeSalary from the
// moved roleGate, nothing else).
//
// supa is a stub that throws if called - the test asserts the three
// early-answer branches never reach it.

import test from "node:test";
import assert from "node:assert/strict";
import { getOverview } from "../entry.js";

const supaThrows = new Proxy({}, {
  get() { throw new Error("supa should not be touched in early-answer tests"); },
});

const TODAY = "2026-11-17";
const corporate = { role: "corporate", scope: null, can_see_salary: true };
const siteLeader = { role: "site_leader", scope: "TBR - FL" };

test("no account -> landing response", async () => {
  const res = await getOverview({
    supa: supaThrows,
    today: TODAY,
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
    caller: null,
    query: {},
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.landing_account, null);
});
