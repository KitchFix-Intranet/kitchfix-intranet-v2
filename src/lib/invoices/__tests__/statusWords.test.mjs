import { test } from "node:test";
import { strict as assert } from "node:assert";
import { statusWordsFor } from "../statusWords.ts";

test("returned with no V2 row -> fix word in block tone", () => {
  assert.deepEqual(statusWordsFor("returned", null, "Needs a fix"),
    { label: "Needs a fix", tone: "block" });
  assert.deepEqual(statusWordsFor("returned", null, "Sent back"),
    { label: "Sent back", tone: "block" });
});

test("sent, no V2 row (v1) -> With accounting", () => {
  assert.deepEqual(statusWordsFor("sent", null, "Needs a fix"),
    { label: "With accounting", tone: "muted" });
});

test("sent + V2 held -> Sending (same for test and live)", () => {
  assert.deepEqual(statusWordsFor("sent", { mode: "test", email_status: "held" }, "Needs a fix"),
    { label: "Sending", tone: "warn" });
  assert.deepEqual(statusWordsFor("sent", { mode: "live", email_status: "held" }, "Needs a fix"),
    { label: "Sending", tone: "warn" });
});

test("sent + V2 sent + mode=test -> Test send", () => {
  assert.deepEqual(statusWordsFor("sent", { mode: "test", email_status: "sent" }, "Needs a fix"),
    { label: "Test send", tone: "info" });
});

test("sent + V2 sent + mode=live -> With accounting", () => {
  assert.deepEqual(statusWordsFor("sent", { mode: "live", email_status: "sent" }, "Needs a fix"),
    { label: "With accounting", tone: "muted" });
});

test("V2 gave_up -> Not delivered + sub-line", () => {
  assert.deepEqual(statusWordsFor("sent", { mode: "live", email_status: "gave_up" }, "Needs a fix"),
    { label: "Not delivered", tone: "block", sub: "The office has been told." });
});

test("returned beats any V2 send row", () => {
  // If a submission is 'returned' at the source table, show the
  // fix word - the V2 send state should not reach this row today,
  // but be safe.
  assert.deepEqual(statusWordsFor("returned", { mode: "test", email_status: "sent" }, "Needs a fix"),
    { label: "Needs a fix", tone: "block" });
});
