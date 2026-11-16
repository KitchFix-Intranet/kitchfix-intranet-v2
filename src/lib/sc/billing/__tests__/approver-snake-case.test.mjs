// sc-63 (Kevin ruling 2026-11-16): the "approved by" names reach
// computeApproverPhrase from both naming conventions. The real
// finalize path hands rows in snake_case; existing fireN1 tests
// pass them in camelCase. Both must work.
//
// Run via: npm run test:sc

import test from "node:test";
import assert from "node:assert/strict";
import { computeApproverPhrase } from "../recordCopyPdf.ts";

test("approver names: snake_case rows from the real path produce the names", () => {
  const { approvers, lede } = computeApproverPhrase({
    reviewRows: [
      { reviewed_by: "Joe Coppolino",  reviewed_at: "2026-07-31T22:00:00Z", service_date: "2026-07-27" },
      { reviewed_by: "Joe Coppolino",  reviewed_at: "2026-07-31T22:01:00Z", service_date: "2026-07-28" },
      { reviewed_by: "Desiree Colone", reviewed_at: "2026-07-31T22:02:00Z", service_date: "2026-07-29" },
    ],
    finalizerName: "Joe Coppolino",
    accountKey: "TBR - FL",
  });
  assert.deepEqual(approvers, ["Joe Coppolino", "Desiree Colone"],
    "snake_case rows produce the names, ordered by day-count DESC");
  assert.match(lede, /Joe Coppolino and Desiree Colone approved the week/);
});

test("approver names: camelCase rows (existing fireN1 tests) still produce the names", () => {
  // Same shape existing qboNotifications.test.mjs passes.
  const { approvers, lede } = computeApproverPhrase({
    reviewRows: [
      { reviewedBy: "Joe Coppolino", reviewedAt: "2026-07-31T22:00:00Z" },
    ],
    finalizerName: "Joe Coppolino",
    accountKey: "TXR - AZ",
  });
  assert.deepEqual(approvers, ["Joe Coppolino"]);
  assert.match(lede, /Joe Coppolino approved every day and sent TXR - AZ to billing/);
});

test("approver names: mixed snake_case and camelCase rows are both read", () => {
  // Defensive: if a caller ever hands a mix (unlikely in practice),
  // the reader does not drop either shape.
  const { approvers } = computeApproverPhrase({
    reviewRows: [
      { reviewed_by: "Joe Coppolino", reviewed_at: "2026-07-31T22:00:00Z" },
      { reviewedBy: "Desiree Colone", reviewedAt: "2026-07-31T22:02:00Z" },
    ],
    finalizerName: "Joe Coppolino",
    accountKey: "TBR - FL",
  });
  assert.equal(approvers.length, 2);
  assert.ok(approvers.includes("Joe Coppolino"));
  assert.ok(approvers.includes("Desiree Colone"));
});
