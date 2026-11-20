// Train 6: every reminder link uses appBaseUrl() + /service/review?
// and never emits "undefined/..." or an empty host. The link's
// `week=` always matches the submit-row Monday the render text names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeReminder } from "../reminderRender.ts";

const base = {
  siteName: "A Test Site",
  leaderDisplayNames: ["Casey Wells"],
  weekStartIso: "2026-11-16",
  weekEndIso:   "2026-11-22",
  isBiweekly: false,
  isBilled: true,
  rdFirstName: null,
  rdCount: 0,
  scWeekLink: "https://kitchfix-intranet-v2.vercel.app/service/review?site=a-site&week=2026-11-16",
  isTest: false,
};

test("Friday weekly: subject + preheader + link in HTML", () => {
  const out = composeReminder({ ...base, kind: "friday" });
  assert.match(out.subject, /ready to check and submit/);
  assert.match(out.preheader, /not submitted yet/);
  // `&` is HTML-escaped to `&amp;` inside the <a href>.
  assert.match(out.html, /service\/review\?site=a-site&amp;week=2026-11-16/);
  assert.doesNotMatch(out.html, /undefined\/service/);
});

test("Monday link's `week=` matches the Monday in the body text", () => {
  // Chat ruling small 11: the Monday reminder's body names last week;
  // the link points at that week's Monday.
  const monFirst = "2026-11-09";
  const monLast  = "2026-11-15";
  const link = `https://kitchfix-intranet-v2.vercel.app/service/review?site=a-site&week=${monFirst}`;
  const out = composeReminder({
    ...base, kind: "monday",
    weekStartIso: monFirst, weekEndIso: monLast,
    scWeekLink: link,
  });
  // Body names Nov 9 - Nov 15 (weekly); link's week is 2026-11-09.
  assert.match(out.html, /Nov 9/);
  assert.match(out.html, /Nov 15/);
  assert.match(out.html, /service\/review\?site=a-site&amp;week=2026-11-09/);
  assert.match(out.text, /2026-11-09/);
});

test("Monday no-RD: trailer reads 'tell the office'", () => {
  const out = composeReminder({ ...base, kind: "monday", rdCount: 0, rdFirstName: null });
  assert.match(out.html, /tell the office/);
  assert.match(out.text, /tell the office/);
});

test("Monday single-RD: trailer uses first name", () => {
  const out = composeReminder({ ...base, kind: "monday", rdCount: 1, rdFirstName: "Jordan" });
  assert.match(out.html, /tell Jordan/);
  assert.match(out.text, /tell Jordan/);
});

test("Monday multi-RD: trailer reads 'tell your regional director' (no name)", () => {
  const out = composeReminder({ ...base, kind: "monday", rdCount: 2, rdFirstName: null });
  assert.match(out.html, /tell your regional director/);
  assert.match(out.text, /tell your regional director/);
  assert.doesNotMatch(out.html, />Jordan</);
});

test("Monday billed vs unbilled branches the body line", () => {
  const billed = composeReminder({ ...base, kind: "monday", isBilled: true });
  assert.match(billed.html, /invoices go out Tuesday/);
  const unbilled = composeReminder({ ...base, kind: "monday", isBilled: false });
  assert.doesNotMatch(unbilled.html, /invoices go out Tuesday/);
  assert.match(unbilled.html, /on record/);
});

test("Friday biweekly: uses the pair wording 'have not been submitted yet' + 'read them through and submit them'", () => {
  const out = composeReminder({
    ...base,
    kind: "friday",
    isBiweekly: true,
    weekStartIso: "2026-11-09",
    weekEndIso: "2026-11-22",
  });
  assert.match(out.html, /These two weeks/);
  assert.match(out.html, /have not been submitted yet/);
  assert.match(out.html, /read them through and submit them/);
  assert.match(out.text, /These two weeks/);
  assert.match(out.text, /have not been submitted yet/);
  assert.match(out.text, /read them through and submit them/);
});

test("Monday biweekly: 'The last two weeks' + 'have not been submitted' + 'submit them'", () => {
  const out = composeReminder({
    ...base,
    kind: "monday",
    isBiweekly: true,
    weekStartIso: "2026-11-09",
    weekEndIso: "2026-11-22",
  });
  assert.match(out.html, /The last two weeks/);
  assert.match(out.html, /have not been submitted/);
  assert.match(out.html, /submit them/);
});

test("isTest=true prefixes subject", () => {
  const out = composeReminder({ ...base, kind: "friday", isTest: true });
  assert.match(out.subject, /^\[TEST\]/);
});

test("site name is HTML-escaped", () => {
  const out = composeReminder({ ...base, kind: "friday", siteName: "A <b>Mess</b>" });
  assert.match(out.html, /A &lt;b&gt;Mess&lt;\/b&gt;/);
  assert.doesNotMatch(out.html, /<b>Mess<\/b>/);
});
