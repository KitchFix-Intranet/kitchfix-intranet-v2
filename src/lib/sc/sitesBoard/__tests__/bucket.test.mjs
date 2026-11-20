// Pure classifier — one case per row kind + the isAskedYet override.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRow } from "../bucket.ts";

const base = {
  isBilled: true,
  hasPushFailedRowV2: false,
  isOfficeViewer: true,
  anyFlaggedDay: false,
  anyUnpricedBillableLine: false,
  dayStates: [],
  isAskedYet: true,
};

test("push_failed V2 + office viewer -> push", () => {
  assert.equal(
    classifyRow({ ...base, weekState: "submitted", hasPushFailedRowV2: true }),
    "push",
  );
});

test("push_failed + RD (not office) -> sent (not push)", () => {
  assert.equal(
    classifyRow({
      ...base,
      weekState: "submitted",
      hasPushFailedRowV2: true,
      isOfficeViewer: false,
    }),
    "sent",
  );
});

test("submitted + billed -> sent", () => {
  assert.equal(classifyRow({ ...base, weekState: "submitted" }), "sent");
});

test("submitted + not billed -> noinv", () => {
  assert.equal(
    classifyRow({ ...base, weekState: "submitted", isBilled: false }),
    "noinv",
  );
});

test("not_serving -> off", () => {
  assert.equal(classifyRow({ ...base, weekState: "not_serving" }), "off");
});

test("period_closed + billed -> sent", () => {
  assert.equal(classifyRow({ ...base, weekState: "period_closed" }), "sent");
});

test("stuck wins over flag and late", () => {
  assert.equal(
    classifyRow({
      ...base,
      weekState: "still_open",
      anyUnpricedBillableLine: true,
      anyFlaggedDay: true,
    }),
    "stuck",
  );
});

test("flag wins over late when nothing is stuck", () => {
  assert.equal(
    classifyRow({
      ...base,
      weekState: "still_open",
      anyFlaggedDay: true,
    }),
    "flag",
  );
});

test("still_open + asked -> late", () => {
  assert.equal(
    classifyRow({
      ...base,
      weekState: "still_open",
      isAskedYet: true,
    }),
    "late",
  );
});

test("still_open + NOT asked (never-submitted exempt) -> open", () => {
  assert.equal(
    classifyRow({
      ...base,
      weekState: "still_open",
      isAskedYet: false,
    }),
    "open",
  );
});

test("entered open week -> entered", () => {
  assert.equal(classifyRow({ ...base, weekState: "entered" }), "entered");
});

test("to_enter open week -> open", () => {
  assert.equal(classifyRow({ ...base, weekState: "to_enter" }), "open");
});
