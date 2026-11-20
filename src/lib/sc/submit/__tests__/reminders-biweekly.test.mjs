// Biweekly sites only produce reminders on the CLOSING week (the
// pair's Monday). The opening week's Monday (week_label "Week 1" or
// "Week 3") produces no submit row and gets reason=not_closing_week.
// On the closing week, the span expands to 14 dates and the render
// uses "these two weeks" wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendReminder, dryRunReminder } from "../reminderSend.ts";
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

test("biweekly opening week ('Week 1') short-circuits with not_closing_week", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - B", region: "West" }],
      sc_qbo_account_map: [{ account_key: "SITE - B", cadence: "biweekly", active: true }],
      sc_day_metadata: [{ account_key: "SITE - B", service_date: "2026-11-09", week_label: "Week 1" }],
      sc_week_finalize: [{ id: "f0", account_key: "SITE - B", week_start: "2025-01-06", status: "finalized" }],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - B", siteName: "B Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-09",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "not_closing_week");
    assert.equal(sb._log.filter((e) => e.op === "insert").length, 0);
  });
});

test("biweekly closing week ('Week 2') expands the unit to 14 days", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - B", region: "West" }],
      sc_qbo_account_map: [{ account_key: "SITE - B", cadence: "biweekly", active: true }],
      sc_day_metadata: [{ account_key: "SITE - B", service_date: "2026-11-16", week_label: "Week 2" }],
      sc_week_finalize: [{ id: "f0", account_key: "SITE - B", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [{ account_key: "SITE - B", service_date: "2026-11-16", actual_count: 0, projected_count: 50 }],
    });
    const r = await dryRunReminder({
      sb, accountKey: "SITE - B", siteName: "B Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    // The pair opens Nov 9 and closes Nov 22.
    assert.equal(r.unitStart, "2026-11-09");
    assert.equal(r.unitEnd, "2026-11-22");
    assert.equal(r.weekStart, "2026-11-16");
  });
});

test("biweekly site with no readable 'Week N' label short-circuits with reason=error", async () => {
  // cadence=biweekly but no sc_day_metadata row (or an unreadable
  // label). The resolver returns isBiweekly=true + weekIndex=null;
  // we refuse rather than treat the site as weekly.
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - B", region: "West" }],
      sc_qbo_account_map: [{ account_key: "SITE - B", cadence: "biweekly", active: true }],
      sc_day_metadata: [], // no label row at all
      sc_week_finalize: [{ id: "f0", account_key: "SITE - B", week_start: "2025-01-06", status: "finalized" }],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - B", siteName: "B Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "error");
    assert.equal(sb._log.filter((e) => e.op === "insert").length, 0);
  });
});

test("biweekly closing week ('Week 4') same expansion", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - B", region: "West" }],
      sc_qbo_account_map: [{ account_key: "SITE - B", cadence: "biweekly", active: true }],
      sc_day_metadata: [{ account_key: "SITE - B", service_date: "2026-11-16", week_label: "Week 4" }],
      sc_week_finalize: [{ id: "f0", account_key: "SITE - B", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [{ account_key: "SITE - B", service_date: "2026-11-16", actual_count: 0, projected_count: 50 }],
    });
    const r = await dryRunReminder({
      sb, accountKey: "SITE - B", siteName: "B Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.unitStart, "2026-11-09");
    assert.equal(r.unitEnd, "2026-11-22");
  });
});
