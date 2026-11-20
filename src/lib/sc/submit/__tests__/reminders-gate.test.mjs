// Mode OFF -> outcome=mode_off. No DB read, no insert, no send.

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

test("gate unset -> outcome=mode_off with zero DB writes", async () => {
  await withOutbound(undefined, async () => {
    const sb = makeReminderSupa({ accounts: [{ team_key: "SITE - A", region: "North" }] });
    const r = await sendReminder({
      sb,
      accountKey: "SITE - A",
      siteName: "A Test Site",
      timezone: "America/Chicago",
      kind: "friday",
      weekStart: "2026-11-16",
    });
    assert.equal(r.outcome, "mode_off");
    assert.equal(r.mode, "off");
    assert.equal(r.decision, "skip");
    const inserts = sb._log.filter((e) => e.op === "insert");
    assert.equal(inserts.length, 0);
  });
});

test("gate=off explicitly set also short-circuits", async () => {
  await withOutbound("off", async () => {
    const sb = makeReminderSupa({ accounts: [{ team_key: "SITE - A", region: "North" }] });
    const r = await sendReminder({
      sb,
      accountKey: "SITE - A",
      siteName: "A Test Site",
      timezone: "America/Chicago",
      kind: "monday",
      weekStart: "2026-11-09",
    });
    assert.equal(r.outcome, "mode_off");
    const inserts = sb._log.filter((e) => e.op === "insert");
    assert.equal(inserts.length, 0);
  });
});

test("dry run returns decision shape with no addresses / subjects", async () => {
  await withOutbound("off", async () => {
    const sb = makeReminderSupa({
      accounts: [{ team_key: "SITE - A", region: "North" }],
      sc_qbo_account_map: [{ account_key: "SITE - A", cadence: "weekly", active: true }],
      sc_week_finalize: [{ id: "f1", account_key: "SITE - A", week_start: "2026-11-16", status: "finalized" }],
    });
    const r = await dryRunReminder({
      sb,
      accountKey: "SITE - A",
      siteName: "A Test Site",
      timezone: "America/Chicago",
      kind: "friday",
      weekStart: "2026-11-16",
    });
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "already_submitted");
    assert.equal(r.mode, "off");
    // Shape contract: no addresses, no names, no subject, no html.
    assert.ok(!("to" in r), "dry result must not carry recipients");
    assert.ok(!("subject" in r), "dry result must not carry a subject");
    assert.ok(!("html" in r), "dry result must not carry html");
  });
});
