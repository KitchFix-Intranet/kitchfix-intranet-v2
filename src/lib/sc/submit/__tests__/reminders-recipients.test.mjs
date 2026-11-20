// Fix 3: Friday goes to the site leaders only. Monday adds the
// regional directors for the account's region. Both counts show up
// on the dry-run shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dryRunReminder } from "../reminderSend.ts";
import { makeReminderSupa } from "./_reminder-supa-mock.mjs";

async function withOutbound(value, fn) {
  const prev = process.env.SC_V2_OUTBOUND;
  if (value === undefined) delete process.env.SC_V2_OUTBOUND;
  else process.env.SC_V2_OUTBOUND = value;
  try { await fn(); }
  finally {
    if (prev === undefined) delete process.env.SC_V2_OUTBOUND;
    else process.env.SC_V2_OUTBOUND = prev;
  }
}

function seed({ leaders = 2, directors = 2 }) {
  const people = [];
  for (let i = 0; i < leaders; i++) {
    people.push({
      work_email: `leader${i}@example.test`,
      display_name: `Leader ${i}`,
      account_key: "SITE - A",
      is_site_leader: i === 0,
      is_salaried: true,
      status: "ACTIVE",
    });
  }
  for (let i = 0; i < directors; i++) {
    people.push({
      work_email: `rd${i}@example.test`,
      display_name: `Director ${i}`,
      region: "North",
      is_regional_director: true,
      is_salaried: true,
      status: "ACTIVE",
    });
  }
  return {
    accounts: [{ team_key: "SITE - A", region: "North" }],
    sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
    sc_week_finalize: [{ id: "f0", account_key: "SITE - A", week_start: "2025-01-06", status: "finalized" }],
    sc_daily_revenue: [
      { account_key: "SITE - A", service_date: "2026-11-09", actual_count: 0, projected_count: 50 },
      { account_key: "SITE - A", service_date: "2026-11-16", actual_count: 0, projected_count: 50 },
    ],
    people,
  };
}

test("Friday counts leaders only; directors=0", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa(seed({ leaders: 3, directors: 2 }));
    const r = await dryRunReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.leaders, 3);
    assert.equal(r.directors, 0);
    assert.equal(r.decision, "remind");
  });
});

test("Monday counts leaders + regional directors for the site region", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa(seed({ leaders: 3, directors: 2 }));
    const r = await dryRunReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "monday", weekStart: "2026-11-09",
    });
    assert.equal(r.leaders, 3);
    assert.equal(r.directors, 2);
    assert.equal(r.decision, "remind");
  });
});

test("Monday with zero directors for the region -> directors=0, decision survives", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa(seed({ leaders: 2, directors: 0 }));
    const r = await dryRunReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "monday", weekStart: "2026-11-09",
    });
    assert.equal(r.leaders, 2);
    assert.equal(r.directors, 0);
  });
});
