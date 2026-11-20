// Train 5: who may reopen a submitted week.
//
// Kevin ruling 2026-11-20: the three people with is_sc_lock_override
// on an ACTIVE row, and the two regional directors (any region).
// Any failure to read -> refuse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canReopenForAccount } from "../canReopenScope.ts";
import { makeSupaMock } from "../../billing/__tests__/_supa-mock.mjs";

function seed(rows) {
  return makeSupaMock({ tables: { people: rows } });
}

test("override on an ACTIVE row -> ok role=override", async () => {
  const sb = seed([
    { work_email: "kevin@example.test", status: "ACTIVE", is_sc_lock_override: true,  is_regional_director: false },
  ]);
  const got = await canReopenForAccount(sb, "kevin@example.test");
  assert.equal(got.ok, true);
  assert.equal(got.role, "override");
});

test("regional director on an ACTIVE row -> ok role=rd (no region bind)", async () => {
  const sb = seed([
    { work_email: "dir@example.test", status: "ACTIVE", is_sc_lock_override: false, is_regional_director: true, region: "East" },
  ]);
  const got = await canReopenForAccount(sb, "dir@example.test");
  assert.equal(got.ok, true);
  assert.equal(got.role, "rd");
});

test("override wins over rd when both flags are set on different rows", async () => {
  const sb = seed([
    { work_email: "both@example.test", status: "ACTIVE", is_sc_lock_override: false, is_regional_director: true },
    { work_email: "both@example.test", status: "ACTIVE", is_sc_lock_override: true,  is_regional_director: false },
  ]);
  const got = await canReopenForAccount(sb, "both@example.test");
  assert.equal(got.ok, true);
  assert.equal(got.role, "override");
});

test("neither flag -> refuse NOT_ALLOWED", async () => {
  const sb = seed([
    { work_email: "worker@example.test", status: "ACTIVE", is_sc_lock_override: false, is_regional_director: false },
  ]);
  const got = await canReopenForAccount(sb, "worker@example.test");
  assert.deepEqual(got, {
    ok: false,
    code: "NOT_ALLOWED",
    message: "Reopening a week is for the office and the regional directors.",
  });
});

test("flag set on a TERMINATED row only -> refuse", async () => {
  const sb = seed([
    { work_email: "ex@example.test", status: "TERMINATED", is_sc_lock_override: true, is_regional_director: false },
  ]);
  const got = await canReopenForAccount(sb, "ex@example.test");
  assert.equal(got.ok, false);
});

test("empty email -> refuse without a people read", async () => {
  const sb = seed([]);
  const got = await canReopenForAccount(sb, "");
  assert.equal(got.ok, false);
});

test("null email -> refuse", async () => {
  const sb = seed([]);
  const got = await canReopenForAccount(sb, null);
  assert.equal(got.ok, false);
});
