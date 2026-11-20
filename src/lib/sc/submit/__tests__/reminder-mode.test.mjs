import { test } from "node:test";
import assert from "node:assert/strict";
import { reminderMode } from "../reminderMode.ts";

test("off outbound -> off reminder", () => {
  assert.equal(reminderMode("off"), "off");
});

test("test outbound -> test reminder", () => {
  assert.equal(reminderMode("test"), "test");
});

test("live outbound -> live reminder", () => {
  assert.equal(reminderMode("live"), "live");
});
