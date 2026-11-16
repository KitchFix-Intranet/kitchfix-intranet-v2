// sc-64: the 9 checks run before a lock.

import test from "node:test";
import assert from "node:assert/strict";
import { checkWeekSubmittable } from "../../submit/checkSubmit.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

const CORP_PERSON = {
  work_email: "kevin@kitchfix.com", status: "ACTIVE", is_corp: true,
  account_key: null, is_salaried: null, is_regional_director: null, region: null,
};
const SITE_PERSON = {
  work_email: "leader@kitchfix.com", status: "ACTIVE", is_corp: null, is_salaried: true,
  account_key: "TXR - AZ", is_regional_director: null, region: null,
};
const ACCOUNT_W = { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" };
const QBO_MAP = { account_key: "TXR - AZ", qbo_mode: "test", cadence: "weekly" };

const WEEK = "2026-07-27"; // Monday
const SITE_TODAY = "2026-07-30"; // some day inside the week

function baseTables(overrides = {}) {
  return {
    people: [CORP_PERSON, SITE_PERSON],
    accounts: [ACCOUNT_W],
    sc_week_finalize: [],
    sc_qbo_account_map: [QBO_MAP],
    sc_qbo_service_map: [
      { service_id: "svc-1", account_key: "TXR - AZ", qbo_item_id: "3338",
        qbo_line_description: "Snack", aggregate_group: null, invoice_slot: "main",
        tax_override: null, line_desc_style: null, active: true, export_excluded: false },
    ],
    sc_day_metadata: [],
    sc_daily_revenue: [],
    ...overrides,
  };
}

function withRpc(tables, rpcOverrides = {}) {
  const mock = makeSupaMock({ tables });
  const base = mock._base();
  // Stub sc_site_today unless overridden.
  const origRpc = base.rpc.bind(base);
  mock.rpc = (name, args) => {
    if (name === "sc_site_today") {
      return Promise.resolve({ data: rpcOverrides.sc_site_today ?? SITE_TODAY, error: null });
    }
    if (name === "sc_is_day_locked") {
      return Promise.resolve({ data: rpcOverrides.sc_is_day_locked ?? false, error: null });
    }
    return origRpc(name, args);
  };
  return mock;
}

test("checks: checkWeekSubmittable throws on a Wednesday weekStart", async () => {
  const supa = withRpc(baseTables());
  await assert.rejects(
    () => checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: "2026-07-29", email: "kevin@kitchfix.com" }, supa),
    /Monday/,
  );
});

test("checks: checkWeekSubmittable throws on a malformed weekStart", async () => {
  const supa = withRpc(baseTables());
  await assert.rejects(
    () => checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: "nope", email: "kevin@kitchfix.com" }, supa),
    /YYYY-MM-DD/,
  );
});

test("checks: NOT_AUTHORIZED stops before any other check runs", async () => {
  const supa = withRpc(baseTables({ people: [] }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "stranger@kitchfix.com" }, supa);
  assert.equal(got.length, 1);
  assert.equal(got[0].code, "NOT_AUTHORIZED");
});

test("checks: ALREADY_SUBMITTED when a live row exists", async () => {
  const supa = withRpc(baseTables({
    sc_week_finalize: [{
      id: "f1", account_key: "TXR - AZ", week_start: WEEK, status: "finalized",
      finalized_by: "leader@kitchfix.com", finalized_at: "2026-07-27T18:00:00Z",
    }],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(codes.includes("ALREADY_SUBMITTED"));
});

test("checks: WEEK_IN_FUTURE when weekStart is after site today", async () => {
  const supa = withRpc(baseTables(), { sc_site_today: "2026-07-26" });
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(codes.includes("WEEK_IN_FUTURE"));
});

test("checks: PERIOD_LOCKED when any day is locked and person has no override", async () => {
  const supa = withRpc(baseTables(), { sc_is_day_locked: true });
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "leader@kitchfix.com" }, supa);
  const periodBlock = got.find((b) => b.code === "PERIOD_LOCKED");
  assert.ok(periodBlock);
  assert.equal(Array.isArray(periodBlock.detail.lockedDates), true);
  assert.ok(periodBlock.detail.lockedDates.length > 0);
});

test("checks: override holder passes a closed period", async () => {
  const supa = withRpc(baseTables({
    people: [
      CORP_PERSON,
      // The override is read inside assertDaysUnlockedForWrite via
      // isScLockOverrideDb. Add an ACTIVE row with the flag.
      { work_email: "kevin@kitchfix.com", status: "ACTIVE", is_corp: true,
        account_key: null, is_salaried: null, is_regional_director: null, region: null,
        is_sc_lock_override: true },
    ],
  }), { sc_is_day_locked: true });
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(!codes.includes("PERIOD_LOCKED"), "override holder passes PERIOD_LOCKED");
});

test("checks: DAY_FLAGGED when any day in the span has review_status flagged", async () => {
  const supa = withRpc(baseTables({
    sc_day_metadata: [
      { account_key: "TXR - AZ", service_date: "2026-07-28", review_status: "flagged" },
      { account_key: "TXR - AZ", service_date: "2026-07-29", review_status: "flagged" },
    ],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const flag = got.find((b) => b.code === "DAY_FLAGGED");
  assert.ok(flag);
  assert.deepEqual(flag.detail.flaggedDates, ["2026-07-28", "2026-07-29"]);
});

test("checks: PROJECTION_UNENTERED when a projected row has no actuals; typed 0 passes", async () => {
  const supa = withRpc(baseTables({
    sc_daily_revenue: [
      // Unentered - projected > 0 and NOT has_actuals.
      { service_date: "2026-07-27", service_id: "svc-1", service_name: "Snack",
        account_key: "TXR - AZ", is_flat_fee: false, is_non_revenue: false, is_tax_free: false,
        actual_count: null, actual_price_at_date: 5.89, price_at_date: 5.89,
        projected_count: 50, period: "8", week_label: "Week 3",
        has_actuals: false, has_projection: true },
      // Typed 0 - projected > 0 and has_actuals true. Passes.
      { service_date: "2026-07-28", service_id: "svc-1", service_name: "Snack",
        account_key: "TXR - AZ", is_flat_fee: false, is_non_revenue: false, is_tax_free: false,
        actual_count: 0, actual_price_at_date: 5.89, price_at_date: 5.89,
        projected_count: 40, period: "8", week_label: "Week 3",
        has_actuals: true, has_projection: true },
    ],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const pu = got.find((b) => b.code === "PROJECTION_UNENTERED");
  assert.ok(pu);
  assert.equal(pu.detail.lines.length, 1, "only the unentered row is flagged; typed 0 passes");
  assert.equal(pu.detail.lines[0].service_date, "2026-07-27");
});

test("checks: UNPRICED_LINES at a billed site when a line has price 0", async () => {
  const supa = withRpc(baseTables({
    sc_daily_revenue: [
      { service_date: "2026-07-27", service_id: "svc-1", service_name: "Snack",
        account_key: "TXR - AZ", is_flat_fee: false, is_non_revenue: false, is_tax_free: false,
        actual_count: 10, actual_price_at_date: 0, price_at_date: 0,
        projected_count: null, period: "8", week_label: "Week 3",
        has_actuals: true, has_projection: false },
    ],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const up = got.find((b) => b.code === "UNPRICED_LINES");
  assert.ok(up);
  assert.equal(up.detail.lines[0].service_id, "svc-1");
});

test("checks: a non-billed site skips UNPRICED_LINES", async () => {
  const supa = withRpc(baseTables({
    sc_qbo_account_map: [], // no QBO map row
    sc_daily_revenue: [
      { service_date: "2026-07-27", service_id: "svc-1", service_name: "Snack",
        account_key: "TXR - AZ", is_flat_fee: false, is_non_revenue: false, is_tax_free: false,
        actual_count: 10, actual_price_at_date: 0, price_at_date: 0,
        projected_count: null, period: "8", week_label: "Week 3",
        has_actuals: true, has_projection: false },
    ],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(!codes.includes("UNPRICED_LINES"));
});

test("checks: several reasons come back together", async () => {
  const supa = withRpc(baseTables({
    sc_week_finalize: [{
      id: "f1", account_key: "TXR - AZ", week_start: WEEK, status: "finalized",
      finalized_by: "leader@kitchfix.com", finalized_at: "2026-07-27T18:00:00Z",
    }],
    sc_day_metadata: [{ account_key: "TXR - AZ", service_date: "2026-07-28", review_status: "flagged" }],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(codes.includes("ALREADY_SUBMITTED"));
  assert.ok(codes.includes("DAY_FLAGGED"));
});

test("checks: biweekly first-week submit is NOT_CLOSING_WEEK and stops", async () => {
  const supa = withRpc(baseTables({
    sc_qbo_account_map: [{ account_key: "TXR - AZ", qbo_mode: "test", cadence: "biweekly" }],
    sc_day_metadata: [{ account_key: "TXR - AZ", service_date: WEEK, week_label: "Week 1" }],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(codes.includes("NOT_CLOSING_WEEK"));
  const ncw = got.find((b) => b.code === "NOT_CLOSING_WEEK");
  assert.equal(ncw.detail.closingWeekStart, "2026-08-03");
});

test("checks: biweekly close-week with no week_label is WEEK_LABEL_MISSING", async () => {
  const supa = withRpc(baseTables({
    sc_qbo_account_map: [{ account_key: "TXR - AZ", qbo_mode: "test", cadence: "biweekly" }],
    sc_day_metadata: [],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: WEEK, email: "kevin@kitchfix.com" }, supa);
  const codes = got.map((b) => b.code);
  assert.ok(codes.includes("WEEK_LABEL_MISSING"));
});

test("checks: biweekly close-week checks 14 days (flagged day in the first week blocks)", async () => {
  const supa = withRpc(baseTables({
    sc_qbo_account_map: [{ account_key: "TXR - AZ", qbo_mode: "test", cadence: "biweekly" }],
    sc_day_metadata: [
      { account_key: "TXR - AZ", service_date: "2026-08-03", week_label: "Week 2" },  // close-week Monday
      { account_key: "TXR - AZ", service_date: "2026-07-29", review_status: "flagged" }, // first-week day
    ],
  }));
  const got = await checkWeekSubmittable({ accountKey: "TXR - AZ", weekStart: "2026-08-03", email: "kevin@kitchfix.com" }, supa);
  const flag = got.find((b) => b.code === "DAY_FLAGGED");
  assert.ok(flag, "a flagged day inside the first week blocks the close-week submit");
  assert.ok(flag.detail.flaggedDates.includes("2026-07-29"));
});
