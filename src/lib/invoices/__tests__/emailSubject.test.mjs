import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildSubject } from "../emailSubject.ts";

test("invoice, live mode", () => {
  const s = buildSubject({
    mode: "live", kind: "invoice",
    site: "SITE_A", vendor: "Acme Foods", number: "ABC-1", total: 1234.56,
  });
  assert.equal(s, "[KitchFix] | SITE_A | Acme Foods | #ABC-1 | $1,234.56");
});

test("credit, live mode: CREDIT | after [KitchFix] | ; total shown positive", () => {
  const s = buildSubject({
    mode: "live", kind: "credit",
    site: "SITE_A", vendor: "Acme Foods", number: "C-99", total: -500,
  });
  assert.equal(s, "[KitchFix] | CREDIT | SITE_A | Acme Foods | #C-99 | $500.00");
});

test("invoice, test mode: [TEST] prefix before [KitchFix]", () => {
  const s = buildSubject({
    mode: "test", kind: "invoice",
    site: "SITE_A", vendor: "Acme Foods", number: "ABC-1", total: 1234.56,
  });
  assert.equal(s, "[TEST] [KitchFix] | SITE_A | Acme Foods | #ABC-1 | $1,234.56");
});

test("credit, test mode: both prefixes", () => {
  const s = buildSubject({
    mode: "test", kind: "credit",
    site: "SITE_A", vendor: "Acme Foods", number: "C-99", total: -500,
  });
  assert.equal(s, "[TEST] [KitchFix] | CREDIT | SITE_A | Acme Foods | #C-99 | $500.00");
});

test("whole-dollar total shows .00", () => {
  const s = buildSubject({
    mode: "live", kind: "invoice",
    site: "A", vendor: "V", number: "N", total: 1000,
  });
  assert.equal(s, "[KitchFix] | A | V | #N | $1,000.00");
});

test("six-figure total gets thousands commas", () => {
  const s = buildSubject({
    mode: "live", kind: "invoice",
    site: "A", vendor: "V", number: "N", total: 123456.78,
  });
  assert.equal(s, "[KitchFix] | A | V | #N | $123,456.78");
});
