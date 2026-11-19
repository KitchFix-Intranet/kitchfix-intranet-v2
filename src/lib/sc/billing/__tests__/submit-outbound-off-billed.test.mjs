// Round 2 billing safety: the submit route refuses a billed-site
// submit when SC_V2_OUTBOUND is off.
//
// Why this gate exists: the four billed accounts (TBR-FL, TXR-AZ,
// TBJ-FL, CIN-AZ) carry qbo_mode = 'live' in a table v1 also writes
// to. v1 bills them live today. If V2 could lock sc_week_finalize
// for one of these accounts while its outbound seam is off, the
// write would land (v1 shares the table) and no QuickBooks push
// would ever fire. v1 wouldn't know; the office wouldn't know.
//
// Answer: a V2-wide gate at the route door. SC_V2_OUTBOUND = off is
// the shipping default. Billed site + off = refused. Non-billed site
// + off = allowed (no push to miss - the office can rehearse the
// finish at any time).

import test from "node:test";
import assert from "node:assert/strict";
import { isSubmitAllowed } from "../../submit/billedOutboundGate.ts";

test("outbound off + billed site = refused (OUTBOUND_OFF)", () => {
  const got = isSubmitAllowed(true, "off");
  assert.equal(got.allowed, false);
  assert.equal(got.code, "OUTBOUND_OFF");
  assert.match(got.message, /not switched on yet/);
});

test("outbound off + non-billed site = allowed (finish rehearsal)", () => {
  const got = isSubmitAllowed(false, "off");
  assert.equal(got.allowed, true);
});

test("outbound test + billed site = allowed (QBO sandbox)", () => {
  const got = isSubmitAllowed(true, "test");
  assert.equal(got.allowed, true);
});

test("outbound test + non-billed site = allowed", () => {
  const got = isSubmitAllowed(false, "test");
  assert.equal(got.allowed, true);
});

test("outbound live + billed site = allowed (QBO production)", () => {
  const got = isSubmitAllowed(true, "live");
  assert.equal(got.allowed, true);
});

test("outbound live + non-billed site = allowed (no push to fire)", () => {
  const got = isSubmitAllowed(false, "live");
  assert.equal(got.allowed, true);
});

test("default mode read: SC_V2_OUTBOUND unset -> off + billed = refused", () => {
  const prior = process.env.SC_V2_OUTBOUND;
  delete process.env.SC_V2_OUTBOUND;
  try {
    const got = isSubmitAllowed(true);
    assert.equal(got.allowed, false);
    assert.equal(got.code, "OUTBOUND_OFF");
  } finally {
    if (prior !== undefined) process.env.SC_V2_OUTBOUND = prior;
  }
});
