// The short-circuits that live before a send is attempted:
//   - already submitted
//   - never submitted + pre-FY27 cutover
//   - unit has no service (projection 0 + actual 0 across the span)
//   - no recipients (leaders + directors both empty in live mode)

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

test("already submitted -> reason=already_submitted, no reminder row", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "f1", account_key: "SITE - A", week_start: "2026-11-16", status: "finalized" }],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "already_submitted");
    assert.equal(sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert").length, 0);
  });
});

test("never-submitted site pre-cutover -> reason=not_asked_yet", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "monday", weekStart: "2026-11-09",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "not_asked_yet");
    assert.equal(sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert").length, 0);
  });
});

test("unit with no service (projection 0 + actual 0 across span) -> reason=no_service", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      // Has a prior submit -> asked yet. This week has no service.
      sc_week_finalize: [{ id: "f0", account_key: "SITE - A", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [
        { account_key: "SITE - A", service_date: "2026-11-16", actual_count: 0, projected_count: 0 },
        { account_key: "SITE - A", service_date: "2026-11-17", actual_count: 0, projected_count: 0 },
        { account_key: "SITE - A", service_date: "2026-11-18", actual_count: null, projected_count: 0 },
      ],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "no_service");
    assert.equal(sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert").length, 0);
  });
});

test("unit WITH service + no recipients in live mode -> reason=no_recipients, row recorded", async () => {
  await withOutbound("live", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "f0", account_key: "SITE - A", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [{ account_key: "SITE - A", service_date: "2026-11-16", actual_count: 0, projected_count: 100 }],
      people: [],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "no_recipients");
    const inserts = sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.email_result, "skipped_no_recipients");
  });
});

test("dry run returns decision + counts without addresses / subjects", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "f1", account_key: "SITE - A", week_start: "2026-11-16", status: "finalized" }],
    });
    const r = await dryRunReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.ok(!("to" in r) && !("cc" in r));
    assert.ok(!("subject" in r) && !("html" in r));
    assert.equal(typeof r.leaders, "number");
    assert.equal(typeof r.directors, "number");
  });
});
