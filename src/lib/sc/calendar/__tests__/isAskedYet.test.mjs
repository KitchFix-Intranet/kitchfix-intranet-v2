// isAskedYet() — eight branches + the cutover boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAskedYet } from "../isAskedYet.ts";

const CUTOVER = "2026-12-28";

test("before cutover + no finalize + unit ended + nothing entered -> false", () => {
  assert.equal(
    isAskedYet({
      today: "2026-11-18",
      anyFinalizeRowEver: false,
      unitEndIso: "2026-11-15",
    }),
    false,
  );
});

test("before cutover + no finalize + unit ended + actuals exist -> still false", () => {
  // The helper changes the DISPLAY verb; actuals on a never-submitted
  // site do not switch it on.
  assert.equal(
    isAskedYet({
      today: "2026-11-18",
      anyFinalizeRowEver: false,
      unitEndIso: "2026-11-15",
    }),
    false,
  );
});

test("before cutover + any finalize row ever -> true", () => {
  assert.equal(
    isAskedYet({
      today: "2026-11-18",
      anyFinalizeRowEver: true,
      unitEndIso: "2026-11-15",
    }),
    true,
  );
});

test("on cutover 2026-12-28 -> true regardless of finalize", () => {
  assert.equal(
    isAskedYet({
      today: CUTOVER,
      anyFinalizeRowEver: false,
      unitEndIso: "2026-12-20",
    }),
    true,
  );
});

test("after cutover -> true regardless of finalize", () => {
  assert.equal(
    isAskedYet({
      today: "2027-01-05",
      anyFinalizeRowEver: false,
      unitEndIso: "2027-01-03",
    }),
    true,
  );
});

test("one day before cutover -> still false when never submitted", () => {
  assert.equal(
    isAskedYet({
      today: "2026-12-27",
      anyFinalizeRowEver: false,
      unitEndIso: "2026-12-20",
    }),
    false,
  );
});

test("unit still open -> false (no late question until the unit ends)", () => {
  assert.equal(
    isAskedYet({
      today: "2026-11-18",
      anyFinalizeRowEver: false,
      unitEndIso: "2026-11-22",
    }),
    false,
  );
});

test("missing today throws", () => {
  assert.throws(
    () =>
      isAskedYet({
        today: "",
        anyFinalizeRowEver: false,
        unitEndIso: "2026-11-15",
      }),
    /today required/,
  );
});

test("custom cutover respected", () => {
  assert.equal(
    isAskedYet({
      today: "2026-10-01",
      anyFinalizeRowEver: false,
      unitEndIso: "2026-09-27",
      cutoverIso: "2026-10-01",
    }),
    true,
  );
});
