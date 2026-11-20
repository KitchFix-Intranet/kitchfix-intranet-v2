// The unique (account_key, week_start, stage, is_test) index on
// sc_v2_reminder_sent means a second cron tick on the same minute
// cannot double-send. Mock enforces the unique, same as the real
// Postgres row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sendReminder } from "../reminderSend.ts";
import { makeReminderSupa } from "./_reminder-supa-mock.mjs";
import { KEVIN_EMAIL } from "../../billing/recipients.ts";

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

test("existing row for the same stage + test flag -> reason=already_reminded", async () => {
  await withOutbound("test", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "any-prev", account_key: "SITE - A", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [{ account_key: "SITE - A", service_date: "2026-11-16", actual_count: 0, projected_count: 100 }],
      people: [],
      sc_v2_reminder_sent: [{
        id: "pre", account_key: "SITE - A", week_start: "2026-11-16",
        stage: "v2.friday", is_test: true,
        recipients_to: [KEVIN_EMAIL], email_result: "sent",
      }],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "already_reminded");
    const inserts = sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert");
    assert.equal(inserts.length, 0);
  });
});

test("a test-mode row does NOT block a live-mode send (is_test differs)", async () => {
  await withOutbound("live", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "any-prev", account_key: "SITE - A", week_start: "2025-01-06", status: "finalized" }],
      sc_daily_revenue: [{ account_key: "SITE - A", service_date: "2026-11-16", actual_count: 0, projected_count: 100 }],
      people: [{
        work_email: "leader@example.test",
        display_name: "Casey Wells",
        account_key: "SITE - A",
        is_site_leader: true,
        is_salaried: true,
        status: "ACTIVE",
      }],
      sc_v2_reminder_sent: [{
        id: "pre", account_key: "SITE - A", week_start: "2026-11-16",
        stage: "v2.friday", is_test: true,
        recipients_to: [KEVIN_EMAIL], email_result: "sent",
      }],
    });
    const r = await sendReminder({
      sb, accountKey: "SITE - A", siteName: "A Test Site",
      timezone: "America/Chicago", kind: "friday", weekStart: "2026-11-16",
    });
    // Outbound stub returns "failed" without real credentials in a
    // test; the point is a NEW row for is_test=false is created,
    // NOT blocked by the test-mode row.
    assert.ok(["sent", "failed"].includes(r.outcome), `unexpected outcome ${r.outcome}`);
    const inserts = sb._log.filter((e) => e.table === "sc_v2_reminder_sent" && e.op === "insert");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].row.is_test, false);
  });
});
