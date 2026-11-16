// sc-61 (Kevin ruling 2026-11-16): the lock override needs an
// active person. `is_sc_lock_override` on a TERMINATED row does
// not unlock anything.
//
// What is tested here:
//   1. Flag on an ACTIVE row returns true.
//   2. Flag on a TERMINATED row returns false.
//   3. Flag on both an ACTIVE and a TERMINATED row for the same
//      address returns true.
//   4. No flag at all returns false.
//   5. A failed read returns false and does not throw.
//
// Run via: npm run test:sc

import test from "node:test";
import assert from "node:assert/strict";
import { isScLockOverrideDb } from "../../admin.ts";
import { makeSupaMock } from "./_supa-mock.mjs";

test("admin override: flag on an ACTIVE row returns true", async () => {
  const supa = makeSupaMock({
    tables: {
      people: [
        { work_email: "kevin@kitchfix.com", is_sc_lock_override: true, status: "ACTIVE" },
      ],
    },
  });
  const got = await isScLockOverrideDb("kevin@kitchfix.com", supa);
  assert.equal(got, true);
});

test("admin override: flag on a TERMINATED row returns false", async () => {
  const supa = makeSupaMock({
    tables: {
      people: [
        { work_email: "ex@kitchfix.com", is_sc_lock_override: true, status: "TERMINATED" },
      ],
    },
  });
  const got = await isScLockOverrideDb("ex@kitchfix.com", supa);
  assert.equal(got, false);
});

test("admin override: flag on both ACTIVE and TERMINATED rows for same address returns true", async () => {
  const supa = makeSupaMock({
    tables: {
      people: [
        { work_email: "veteran@kitchfix.com", is_sc_lock_override: true, status: "TERMINATED" },
        { work_email: "veteran@kitchfix.com", is_sc_lock_override: true, status: "ACTIVE" },
      ],
    },
  });
  const got = await isScLockOverrideDb("veteran@kitchfix.com", supa);
  assert.equal(got, true);
});

test("admin override: no flag at all returns false", async () => {
  const supa = makeSupaMock({
    tables: {
      people: [
        { work_email: "regular@kitchfix.com", is_sc_lock_override: false, status: "ACTIVE" },
      ],
    },
  });
  const got = await isScLockOverrideDb("regular@kitchfix.com", supa);
  assert.equal(got, false);
});

test("admin override: a failed read returns false and does not throw", async () => {
  // Fake supa that throws on .from().
  const throwing = {
    from() { throw new Error("DB unreachable"); },
  };
  const got = await isScLockOverrideDb("anyone@kitchfix.com", throwing);
  assert.equal(got, false, "returns false on any failure");
});
