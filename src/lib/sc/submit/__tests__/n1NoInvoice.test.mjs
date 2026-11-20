// Owner-only no-invoice notice. Kevin ruling 2026-11-20:
//   - A submit on a non-billed site tells Kevin ONLY.
//   - Name the submitter from `people`, "Someone" fallback.
//   - No dollars.
//   - Meals stay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoInvoiceNotice, sendNoInvoiceNotice } from "../n1NoInvoice.ts";

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

const base = {
  accountKey: "SITE - A",
  siteName: "A Test Site",
  weekStart: "2026-11-16",
  unitSpanDays: 7,
  totalMeals: 310,
  submittedByName: "Casey Wells",
};

test("subject uses plain words in live mode", () => {
  const { subject } = buildNoInvoiceNotice(base, false);
  assert.match(subject, /^Week submitted · A Test Site · /);
  assert.match(subject, /on record only$/);
  assert.doesNotMatch(subject, /^\[TEST\]/);
});

test("subject gains the [TEST] prefix in test mode", () => {
  const { subject } = buildNoInvoiceNotice(base, true);
  assert.match(subject, /^\[TEST\] /);
});

test("body names the submitter from `people`, not an email", () => {
  const { html } = buildNoInvoiceNotice(base, false);
  assert.match(html, />Casey Wells submitted\./);
  assert.doesNotMatch(html, /@/);
});

test("missing display name falls back to 'Someone'", () => {
  const { html } = buildNoInvoiceNotice({ ...base, submittedByName: null }, false);
  assert.match(html, />Someone submitted\./);
});

test("body carries meals, no dollars, no cents", () => {
  const { html } = buildNoInvoiceNotice(base, false);
  assert.match(html, />Meals: 310</);
  assert.doesNotMatch(html, /\$/);
  assert.doesNotMatch(html, /Before tax/i);
});

test("body escapes the site name + the submitter name", () => {
  const { html } = buildNoInvoiceNotice({ ...base, siteName: "<b>X</b>", submittedByName: "<i>Z</i>" }, false);
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  assert.match(html, /&lt;i&gt;Z&lt;\/i&gt;/);
});

test("biweekly unit (14 days) formats as the pair range", () => {
  const { html } = buildNoInvoiceNotice({ ...base, unitSpanDays: 14 }, false);
  assert.match(html, /Nov 16/);
  assert.match(html, /Nov 29/);
});

test("mode=off short-circuits with outcome=mode_off", async () => {
  await withOutbound("off", async () => {
    const r = await sendNoInvoiceNotice(base);
    assert.equal(r.outcome, "mode_off");
  });
});
